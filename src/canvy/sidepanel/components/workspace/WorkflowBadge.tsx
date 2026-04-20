interface WorkflowBadgeProps {
  label: string;
}

export function WorkflowBadge({ label }: WorkflowBadgeProps) {
  return <span className="canvy-chip">{label}</span>;
}
