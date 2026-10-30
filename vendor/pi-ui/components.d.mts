import type { Component, Container, TUI } from '@earendil-works/pi-tui';
export class UserMessageComponent extends Container { constructor(text: string); }
export class AssistantMessageComponent extends Container { constructor(message?: { content: { type: string; text?: string }[]; stopReason?: string }, hideThinking?: boolean); }
export class ToolExecutionComponent extends Container {
  constructor(name: string, id: string, args: unknown, options: { showImages: boolean }, definition: Record<string, (...args: any[]) => Component | undefined> | undefined, tui: TUI, cwd: string);
  markExecutionStarted(): void;
  setArgsComplete(): void;
  updateResult(result: { content: { type: string; text: string }[]; isError: boolean; durationMs?: number }): void;
  setExpanded(expanded: boolean): void;
}
export const theme: { fg(token: string, text: string): string; bold(text: string): string };
export function loadThemeFromPath(path: string, mode?: string): unknown;
export function setThemeInstance(theme: unknown): void;
export function getMarkdownTheme(): unknown;
export function createShellRenderers(prompt: string): Record<string, (...args: any[]) => Component | undefined>;
export const readRenderers: Record<string, (...args: any[]) => Component | undefined>;
export const writeRenderers: Record<string, (...args: any[]) => Component | undefined>;
