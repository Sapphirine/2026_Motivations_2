#!/usr/bin/env python3
"""Local Chroma policy-grounding sidecar for MotiveOps.

This service intentionally stays small: it loads curated policy chunks from
rag_corpus/policy_chunks.json, stores them in a persistent Chroma collection,
and exposes a POST /query endpoint for the Worker.

Embedding mode:
  - default: deterministic lexical hash embeddings, no network or model download
  - purpose: local vector retrieval for a class demo
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

try:
    import chromadb
except ImportError as exc:  # pragma: no cover - exercised by local operator
    raise SystemExit(
        "chromadb is not installed. Run: python3 -m pip install -r rag_server/requirements.txt"
    ) from exc


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CORPUS = ROOT / "rag_corpus" / "policy_chunks.json"
DEFAULT_CHROMA_PATH = ROOT / ".chroma" / "policy"
COLLECTION_NAME = "motiveops_policy_chunks_v1"
EMBED_DIM = 384


def tokenize(text: str) -> list[str]:
    tokens = re.findall(r"[a-z0-9][a-z0-9_-]{1,}", text.lower())
    bigrams = [f"{tokens[i]}_{tokens[i + 1]}" for i in range(len(tokens) - 1)]
    return tokens + bigrams


def hash_embedding(text: str, dim: int = EMBED_DIM) -> list[float]:
    vector = [0.0] * dim
    for token in tokenize(text):
        digest = hashlib.blake2b(token.encode("utf-8"), digest_size=8).digest()
        value = int.from_bytes(digest, "big")
        index = value % dim
        sign = 1.0 if ((value >> 9) & 1) else -1.0
        vector[index] += sign
    norm = math.sqrt(sum(item * item for item in vector)) or 1.0
    return [item / norm for item in vector]


def load_corpus(path: Path) -> list[dict[str, Any]]:
    with path.open("r", encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, list):
        raise ValueError(f"Corpus must be a JSON list: {path}")
    return [chunk for chunk in data if isinstance(chunk, dict)]


def metadata_for(chunk: dict[str, Any]) -> dict[str, str]:
    return {
        "title": str(chunk.get("title", "")),
        "source": str(chunk.get("source", "")),
        "domain": str(chunk.get("domain", "")),
        "riskTypes": ", ".join(chunk.get("riskTypes", []) or []),
        "stakeholders": ", ".join(chunk.get("stakeholders", []) or []),
        "deploymentStage": str(chunk.get("deploymentStage", "")),
        "tags": ", ".join(chunk.get("tags", []) or []),
    }


def document_for(chunk: dict[str, Any]) -> str:
    parts = [
        chunk.get("title", ""),
        chunk.get("text", ""),
        chunk.get("source", ""),
        chunk.get("domain", ""),
        " ".join(chunk.get("riskTypes", []) or []),
        " ".join(chunk.get("stakeholders", []) or []),
        chunk.get("deploymentStage", ""),
        " ".join(chunk.get("tags", []) or []),
    ]
    return "\n".join(str(part) for part in parts if part)


class PolicyIndex:
    def __init__(self, corpus_path: Path, chroma_path: Path):
        self.corpus_path = corpus_path
        self.chroma_path = chroma_path
        self.client = chromadb.PersistentClient(path=str(chroma_path))
        self.collection = self.client.get_or_create_collection(
            COLLECTION_NAME,
            metadata={"description": "MotiveOps policy-grounding chunks"},
        )
        self.chunks = load_corpus(corpus_path)
        self.chunk_by_id = {str(chunk["id"]): chunk for chunk in self.chunks if chunk.get("id")}
        self.ingest()

    def ingest(self) -> None:
        ids: list[str] = []
        documents: list[str] = []
        metadatas: list[dict[str, str]] = []
        embeddings: list[list[float]] = []
        for chunk in self.chunks:
            chunk_id = str(chunk.get("id", "")).strip()
            text = str(chunk.get("text", "")).strip()
            if not chunk_id or not text:
                continue
            doc = document_for(chunk)
            ids.append(chunk_id)
            documents.append(doc)
            metadatas.append(metadata_for(chunk))
            embeddings.append(hash_embedding(doc))
        if ids:
            self.collection.upsert(
                ids=ids,
                documents=documents,
                metadatas=metadatas,
                embeddings=embeddings,
            )

    def query(self, query: str, risk_context: dict[str, Any] | None, top_k: int) -> list[dict[str, Any]]:
        top_k = max(1, min(int(top_k or 5), 8))
        count = max(1, self.collection.count())
        n_results = min(count, max(top_k * 4, top_k))
        expanded_query = self.expand_query(query, risk_context)
        results = self.collection.query(
            query_embeddings=[hash_embedding(expanded_query)],
            n_results=n_results,
            include=["documents", "metadatas", "distances"],
        )
        ids = (results.get("ids") or [[]])[0]
        distances = (results.get("distances") or [[]])[0]
        metadatas = (results.get("metadatas") or [[]])[0]
        ranked: list[dict[str, Any]] = []
        for idx, chunk_id in enumerate(ids):
            chunk = self.chunk_by_id.get(chunk_id)
            if not chunk:
                continue
            distance = float(distances[idx]) if idx < len(distances) else 1.0
            metadata = metadatas[idx] if idx < len(metadatas) and isinstance(metadatas[idx], dict) else {}
            score = (1.0 / (1.0 + max(0.0, distance))) + self.metadata_bonus(metadata, risk_context)
            ranked.append(self.serialize_chunk(chunk, min(score, 1.0)))
        ranked.sort(key=lambda item: item["score"], reverse=True)
        return ranked[:top_k]

    @staticmethod
    def expand_query(query: str, risk_context: dict[str, Any] | None) -> str:
        if not risk_context:
            return query
        fields = [
            risk_context.get("domain", ""),
            risk_context.get("deploymentStage", ""),
            " ".join(risk_context.get("riskTypes", []) or []),
            " ".join(risk_context.get("affectedStakeholders", []) or []),
            " ".join(risk_context.get("detectionSignals", []) or []),
        ]
        return "\n".join([query, *[str(field) for field in fields if field]])

    @staticmethod
    def metadata_bonus(metadata: dict[str, Any], risk_context: dict[str, Any] | None) -> float:
        if not risk_context:
            return 0.0
        domain = str(risk_context.get("domain", "")).lower()
        risk_types = {str(item).lower() for item in (risk_context.get("riskTypes", []) or [])}
        stakeholders = {str(item).lower() for item in (risk_context.get("affectedStakeholders", []) or [])}
        meta_domain = str(metadata.get("domain", "")).lower()
        meta_risks = split_meta(metadata.get("riskTypes", ""))
        meta_stakeholders = split_meta(metadata.get("stakeholders", ""))
        bonus = 0.0
        if domain and (domain in meta_domain or meta_domain in domain):
            bonus += 0.12
        bonus += min(0.24, 0.06 * len(risk_types & meta_risks))
        bonus += min(0.08, 0.02 * len(stakeholders & meta_stakeholders))
        return bonus

    @staticmethod
    def serialize_chunk(chunk: dict[str, Any], score: float) -> dict[str, Any]:
        return {
            "id": chunk.get("id", ""),
            "title": chunk.get("title", ""),
            "source": chunk.get("source", ""),
            "domain": chunk.get("domain", ""),
            "riskTypes": chunk.get("riskTypes", []) or [],
            "stakeholders": chunk.get("stakeholders", []) or [],
            "deploymentStage": chunk.get("deploymentStage", ""),
            "text": chunk.get("text", ""),
            "score": round(float(score), 4),
        }


def split_meta(value: Any) -> set[str]:
    return {part.strip().lower() for part in str(value).split(",") if part.strip()}


def make_handler(index: PolicyIndex):
    class Handler(BaseHTTPRequestHandler):
        server_version = "MotiveOpsPolicyRAG/0.1"

        def do_GET(self) -> None:
            if self.path == "/health":
                self.respond({
                    "ok": True,
                    "mode": "chroma",
                    "collection": COLLECTION_NAME,
                    "corpusPath": str(index.corpus_path),
                    "chromaPath": str(index.chroma_path),
                    "chunkCount": len(index.chunks),
                    "collectionCount": index.collection.count(),
                    "embedding": "local lexical hash",
                })
                return
            self.respond({"error": "not found"}, status=HTTPStatus.NOT_FOUND)

        def do_POST(self) -> None:
            if self.path != "/query":
                self.respond({"error": "not found"}, status=HTTPStatus.NOT_FOUND)
                return
            try:
                length = int(self.headers.get("content-length", "0"))
                payload = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
                query = str(payload.get("query", "")).strip()
                if not query:
                    self.respond({"error": "query is required"}, status=HTTPStatus.BAD_REQUEST)
                    return
                chunks = index.query(query, payload.get("riskContext") or {}, int(payload.get("topK", 5)))
                self.respond({"mode": "chroma", "chunks": chunks})
            except Exception as exc:  # pragma: no cover - defensive service boundary
                self.respond({"error": str(exc)}, status=HTTPStatus.INTERNAL_SERVER_ERROR)

        def log_message(self, fmt: str, *args: Any) -> None:
            print("[policy-rag]", fmt % args)

        def respond(self, payload: dict[str, Any], status: int | HTTPStatus = HTTPStatus.OK) -> None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(int(status))
            self.send_header("content-type", "application/json; charset=utf-8")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    return Handler


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the MotiveOps local Chroma policy RAG sidecar.")
    parser.add_argument("--host", default=os.environ.get("POLICY_RAG_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("POLICY_RAG_PORT", "8010")))
    parser.add_argument("--corpus", type=Path, default=DEFAULT_CORPUS)
    parser.add_argument("--chroma-path", type=Path, default=DEFAULT_CHROMA_PATH)
    args = parser.parse_args()

    index = PolicyIndex(args.corpus, args.chroma_path)
    server = ThreadingHTTPServer((args.host, args.port), make_handler(index))
    print(f"[policy-rag] ready on http://{args.host}:{args.port}")
    print(f"[policy-rag] loaded {len(index.chunks)} chunks from {args.corpus}")
    server.serve_forever()


if __name__ == "__main__":
    main()
