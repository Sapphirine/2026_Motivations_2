import { Cpu, GitMerge, Scale } from 'lucide-react';

/**
 * Inline SVG diagram explaining the experiment topology:
 *   4 motivation-weighted agents (same model) -> playbook-guided recommendations -> divergence + alignment metrics.
 *
 * Renders crisp at 320px (mobile) and 800px+ (desktop) via viewBox + responsive container.
 * No emoji. lucide-react icons only.
 */
export default function AgentWorkflowDiagram() {
  const profileLabels = ['Achievement', 'Exploration', 'Preservation', 'Neutral'];
  return (
    <figure
      className="workflow-diagram"
      aria-label="Agent workflow: four motivation-weighted agents converge into a deterministic moderator that emits divergence and intervention-alignment metrics."
    >
      <svg
        viewBox="0 0 800 320"
        preserveAspectRatio="xMidYMid meet"
        aria-hidden="true"
      >
        <defs>
          <marker
            id="arrow-head"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M0,0 L10,5 L0,10 z" fill="#5B5CE2" />
          </marker>
        </defs>

        {/* Column 1: 4 agent boxes */}
        {profileLabels.map((label, index) => {
          const y = 20 + index * 70;
          return (
            <g key={label}>
              <rect
                x="20"
                y={y}
                width="200"
                height="52"
                rx="12"
                ry="12"
                fill="#FFFCF6"
                stroke="#D8D2C8"
                strokeWidth="1"
              />
              <text x="38" y={y + 22} fontFamily="Inter, sans-serif" fontSize="13" fontWeight="700" fill="#232323">
                Agent · {label}
              </text>
              <text x="38" y={y + 40} fontFamily="Inter, sans-serif" fontSize="11" fill="#666A73">
                gpt-5.4-nano · motivation-weighted
              </text>
              {/* Arrow agent -> moderator */}
              <line
                x1="220"
                y1={y + 26}
                x2="360"
                y2="160"
                stroke="#5B5CE2"
                strokeWidth="1.5"
                markerEnd="url(#arrow-head)"
                opacity="0.78"
              />
            </g>
          );
        })}

        {/* Column 2: moderator */}
        <rect
          x="360"
          y="120"
          width="200"
          height="80"
          rx="14"
          ry="14"
          fill="#F1F0FF"
          stroke="#5B5CE2"
          strokeWidth="1.4"
        />
        <text x="378" y="148" fontFamily="Inter, sans-serif" fontSize="13" fontWeight="800" fill="#232323">
          Moderator
        </text>
        <text x="378" y="166" fontFamily="Inter, sans-serif" fontSize="11" fill="#666A73">
          deterministic · no LLM
        </text>
        <text x="378" y="184" fontFamily="Inter, sans-serif" fontSize="11" fill="#666A73">
          scores 4 interventions
        </text>

        {/* Arrow moderator -> metrics */}
        <line
          x1="560"
          y1="160"
          x2="600"
          y2="160"
          stroke="#5B5CE2"
          strokeWidth="1.5"
          markerEnd="url(#arrow-head)"
        />

        {/* Column 3: metrics output */}
        <rect
          x="600"
          y="100"
          width="180"
          height="120"
          rx="14"
          ry="14"
          fill="#FFFCF6"
          stroke="#D8D2C8"
          strokeWidth="1"
        />
        <text x="618" y="128" fontFamily="Inter, sans-serif" fontSize="13" fontWeight="800" fill="#232323">
          Adoption metrics
        </text>
        <text x="618" y="150" fontFamily="Inter, sans-serif" fontSize="11" fill="#666A73">
          divergence rate
        </text>
        <text x="618" y="168" fontFamily="Inter, sans-serif" fontSize="11" fill="#666A73">
          alignment detection
        </text>
        <text x="618" y="186" fontFamily="Inter, sans-serif" fontSize="11" fill="#666A73">
          per-axis flip checks
        </text>
      </svg>

      <figcaption className="workflow-caption">
        <span><Cpu aria-hidden="true" /> 4 agents · same model</span>
        <span><GitMerge aria-hidden="true" /> deterministic moderator</span>
        <span><Scale aria-hidden="true" /> divergence + alignment</span>
      </figcaption>
    </figure>
  );
}
