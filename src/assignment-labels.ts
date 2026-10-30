import { terminalText } from './native-terminal.js';

/** Manager-owned roadmap labels; never infer a milestone from task prose or state. */
export function assignmentLabels(roadmap: string): Map<string, string> {
  const labels = new Map<string, string>();
  for (const line of roadmap.split('\n')) {
    const match = line.match(/^\s*-\s+\[assignment:([^\]\s]+)\]\s+(.+)$/);
    if (match) labels.set(match[1]!, terminalText(match[2]).replace(/\s+/g, ' ').trim().slice(0, 160));
  }
  return labels;
}
export function assignmentStateLabel(state: string): string {
  return ({running:'Working',queued:'Queued',accepted:'Accepted',needs_review:'Ready for review',revision_requested:'Changes requested',cancelled:'Ended',blocked:'Paused',failed:'Failed',unanswered:'Needs attention',cancelling:'Stopping',budget:'Budget reached',timeout:'Timed out'} as Record<string,string>)[state] ?? state.replace(/_/g, ' ');
}
