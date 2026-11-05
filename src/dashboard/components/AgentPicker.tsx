import { AGENT_CHOICES, type AgentChoice, agentName } from "../agents";

type Props = {
  value: string;
  onChange: (agent: AgentChoice) => void;
  disabled?: boolean;
  label: string;
};

export function AgentPicker({ value, onChange, disabled, label }: Props) {
  return (
    <select
      className="pick"
      value={value}
      disabled={disabled}
      aria-label={label}
      title={label}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => onChange(e.target.value as AgentChoice)}
    >
      {AGENT_CHOICES.map((id) => (
        <option key={id} value={id}>
          {agentName(id)}
        </option>
      ))}
    </select>
  );
}
