import { z } from 'zod';
import { Tool } from '../types/index.js';

/**
 * Tool for Claude to invoke Gemini agent
 */
export const invokeGeminiTool: Tool = {
  name: 'invoke_gemini',
  description:
    'Invoke the Gemini agent for web search, summarization, or quick information retrieval tasks. Use when you need to search the web, find recent information, or get quick summaries.',
  inputSchema: z.object({
    task: z.string().describe('The task or question for the Gemini agent'),
    context: z
      .string()
      .optional()
      .describe('Additional context to help Gemini understand the task'),
  }),
};

/**
 * Tool for Claude to invoke another Claude instance (for parallel processing)
 */
export const invokeClaudeTool: Tool = {
  name: 'invoke_claude',
  description:
    'Invoke another Claude agent for deep reasoning, code analysis, or complex problem-solving. Use for parallel processing of complex technical tasks.',
  inputSchema: z.object({
    task: z.string().describe('The task or question for the Claude agent'),
    context: z
      .string()
      .optional()
      .describe('Additional context to help Claude understand the task'),
  }),
};

/**
 * Tool for web search (to be handled by Gemini)
 */
export const webSearchTool: Tool = {
  name: 'web_search',
  description:
    'Search the web for information. Returns search results with titles, URLs, and snippets.',
  inputSchema: z.object({
    query: z.string().describe('The search query'),
    num_results: z
      .number()
      .optional()
      .default(5)
      .describe('Number of results to return'),
  }),
};

/**
 * Tool for summarization (to be handled by Gemini)
 */
export const summarizeTool: Tool = {
  name: 'summarize',
  description: 'Summarize a long text or multiple pieces of information into a concise format.',
  inputSchema: z.object({
    text: z.string().describe('The text to summarize'),
    max_length: z
      .number()
      .optional()
      .describe('Maximum length of the summary in words'),
    style: z
      .enum(['brief', 'detailed', 'bullet_points'])
      .optional()
      .default('brief')
      .describe('Style of the summary'),
  }),
};

/**
 * Get all cross-agent tools
 */
export function getCrossAgentTools(): Tool[] {
  return [invokeGeminiTool, invokeClaudeTool];
}

/**
 * Get Gemini-specific tools
 */
export function getGeminiTools(): Tool[] {
  return [webSearchTool, summarizeTool];
}
