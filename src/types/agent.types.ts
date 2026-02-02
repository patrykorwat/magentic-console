import { z } from 'zod';

/**
 * File attachment for messages
 */
export interface FileAttachment {
  filename: string;
  originalName: string;
  path: string;
  mimeType: string;
  size: number;
}

/**
 * Base message types for agent communication
 */
export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string | any[]; // Can be string or array of content blocks (for Claude API)
  files?: FileAttachment[]; // Optional file attachments
}

/**
 * Tool definition for agent capabilities
 */
export interface Tool {
  name: string;
  description: string;
  inputSchema: z.ZodSchema<any>;
}

/**
 * Tool call request from an agent
 */
export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, any>;
}

/**
 * Tool call result
 */
export interface ToolResult {
  toolCallId: string;
  output: any;
  isError?: boolean;
}

/**
 * Agent response containing text and optional tool calls
 */
export interface AgentResponse {
  content: string;
  toolCalls?: ToolCall[];
  stopReason?: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';
  rawContent?: any; // Raw content from API for proper message continuation
}

/**
 * Agent configuration
 */
export interface AgentConfig {
  name: string;
  model?: string;
  systemPrompt?: string;
  customPrompt?: string; // User-provided custom prompt override
  temperature?: number;
  maxTokens?: number;
  tools?: Tool[];
}

/**
 * Base Agent interface following Magentic pattern
 */
export interface Agent {
  name: string;
  capabilities: string[];

  /**
   * Execute a task with the agent
   */
  execute(messages: Message[]): Promise<AgentResponse>;

  /**
   * Execute with tool results
   */
  executeWithTools(
    messages: Message[],
    toolResults: ToolResult[]
  ): Promise<AgentResponse>;

  /**
   * Get available tools
   */
  getTools(): Tool[];
}

/**
 * Plan step for manager agent
 */
export interface PlanStep {
  step: number;
  description: string;
  agent: 'claude' | 'gemini' | 'ollama' | 'manager';
  model?: string; // Konkretny model dla tego kroku (np. 'claude-3-5-haiku-20241022' dla Claude, 'llama3.2' dla Ollama)
  reasoning: string;
  requiredFiles?: string[]; // Lista nazw plików potrzebnych w tym kroku
}

/**
 * Execution plan
 */
export interface Plan {
  goal: string;
  steps: PlanStep[];
  estimatedComplexity: 'low' | 'medium' | 'high';
}

/**
 * MCP Server configuration
 */
export interface MCPServerConfig {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}
