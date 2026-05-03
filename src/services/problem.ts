import type { ProblemDetails } from '../domain/types';

export class ProblemError extends Error {
  readonly details: ProblemDetails;

  constructor(details: ProblemDetails) {
    super(details.detail);
    this.name = 'ProblemError';
    this.details = details;
  }
}

export function problem(status: number, title: string, detail: string, instance: string, errors?: ProblemDetails['errors']): ProblemDetails {
  return {
    type: `https://motiveops.local/problems/${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`,
    title,
    status,
    detail,
    instance,
    ...(errors?.length ? { errors } : {}),
  };
}

export function problemError(status: number, title: string, detail: string, instance: string, errors?: ProblemDetails['errors']): ProblemError {
  return new ProblemError(problem(status, title, detail, instance, errors));
}
