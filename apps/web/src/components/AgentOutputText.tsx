import { Markdown } from "./Markdown.tsx";

export function AgentOutputText({
  text,
  className,
}: {
  text: string;
  className?: string;
  animate?: boolean;
}) {
  return <Markdown className={className}>{text}</Markdown>;
}
