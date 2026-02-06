import { ClaudeAgent } from './agents/claude-agent.js';
import { GeminiAgent } from './agents/gemini-agent.js';
import { ManagerAgent } from './agents/manager-agent.js';
import { OllamaAgent } from './agents/ollama-agent.js';
import {
  Message,
  ToolCall,
  ToolResult,
  Plan,
  MCPServerConfig,
  AgentConfig,
  FileAttachment,
  AgentResponse,
} from './types/index.js';
import { getCrossAgentTools, getGeminiTools } from './tools/index.js';

export interface OrchestratorConfig {
  anthropicApiKey: string;
  googleApiKey: string;
  mcpServers?: MCPServerConfig[];
  claudeConfig?: Partial<AgentConfig>;
  geminiConfig?: Partial<AgentConfig>;
  ollamaConfig?: Partial<AgentConfig>;
  ollamaBaseUrl?: string;
  managerPrompt?: string;
}

/**
 * Magentic Orchestrator
 * Coordinates between Manager, Claude, Gemini, and Ollama agents
 */
export class MagenticOrchestrator {
  private manager: ManagerAgent;
  private claude: ClaudeAgent;
  private gemini: GeminiAgent;
  private ollama: OllamaAgent | null = null;
  private conversationHistory: Message[] = [];
  public aborted: boolean = false;
  public currentStepToolCalls: Array<{ id: string; name: string; input: Record<string, any>; result?: any }> = [];

  constructor(private config: OrchestratorConfig) {
    // Initialize Manager Agent with default Claude model from config and MCP servers
    const defaultClaudeModel = config.claudeConfig?.model || 'claude-sonnet-4-5-20250929';
    this.manager = new ManagerAgent(
      config.anthropicApiKey,
      defaultClaudeModel,
      config.managerPrompt,
      config.mcpServers || []
    );

    // Initialize Claude Agent with cross-agent tools and MCP support
    this.claude = new ClaudeAgent(
      config.anthropicApiKey,
      {
        name: 'Claude',
        tools: getCrossAgentTools(),
        ...config.claudeConfig,
      },
      config.mcpServers || []
    );

    // Initialize Gemini Agent with its specific tools
    this.gemini = new GeminiAgent(config.googleApiKey, {
      name: 'Gemini',
      tools: getGeminiTools(),
      ...config.geminiConfig,
    });

    // Initialize Ollama Agent if configured (with MCP support)
    if (config.ollamaConfig || config.ollamaBaseUrl) {
      this.ollama = new OllamaAgent(
        {
          name: 'Ollama',
          ...config.ollamaConfig,
        },
        config.ollamaBaseUrl,
        config.mcpServers || []
      );
    }
  }

  /**
   * Initialize the orchestrator (e.g., connect to MCP servers)
   */
  async initialize(): Promise<void> {
    console.log('[Orchestrator] Initializing...');

    // Initialize Manager MCP for schema fetching
    await this.manager.initializeMCP();

    await this.claude.initializeMCP();

    // Initialize Ollama MCP if configured
    if (this.ollama) {
      await this.ollama.initializeMCP();
    }

    console.log('[Orchestrator] Initialized successfully');
  }

  /**
   * Set the Claude model for the next execution
   */
  setClaudeModel(model: string): void {
    this.claude.setModel(model);
  }

  /**
   * Cleanup resources
   */
  async cleanup(): Promise<void> {
    console.log('[Orchestrator] Cleaning up...');

    // Cleanup Manager MCP
    await this.manager.closeMCP();

    await this.claude.closeMCP();

    // Cleanup Ollama MCP if configured
    if (this.ollama) {
      await this.ollama.closeMCP();
    }

    console.log('[Orchestrator] Cleanup complete');
  }

  /**
   * Execute a task with automatic planning and delegation
   */
  async executeTask(task: string, autoMode: boolean = false): Promise<string> {
    console.log(`\n[Orchestrator] Received task: ${task}`);

    // Step 1: Create a plan
    console.log('[Orchestrator] Creating execution plan...');
    const plan = await this.manager.createPlan(task);
    console.log('[Orchestrator] Plan created:');
    console.log(JSON.stringify(plan, null, 2));

    if (!autoMode) {
      // In manual mode, return the plan for user approval
      return this.formatPlan(plan);
    }

    // Step 2: Execute the plan
    return await this.executePlan(plan);
  }

  /**
   * Execute a pre-approved plan
   */
  async executePlan(plan: Plan): Promise<string> {
    console.log('\n[Orchestrator] Executing plan...');
    const results: string[] = [];

    for (const step of plan.steps) {
      console.log(`\n[Orchestrator] Step ${step.step}: ${step.description}`);
      console.log(`[Orchestrator] Agent: ${step.agent}`);
      if (step.model) {
        console.log(`[Orchestrator] Model: ${step.model}`);
      }

      let result: string;

      switch (step.agent) {
        case 'claude':
          // Set Claude model if specified in step
          if (step.model && this.claude) {
            this.claude.setModel(step.model);
          }
          result = await this.executeWithClaude(step.description);
          break;
        case 'gemini':
          // Note: Gemini model selection not implemented yet
          result = await this.executeWithGemini(step.description);
          break;
        case 'ollama':
          // Set Ollama model if specified in step
          if (step.model && this.ollama) {
            this.ollama.setModel(step.model);
          }
          result = await this.executeWithOllama(step.description);
          break;
        case 'manager':
          result = await this.executeWithManager(step.description);
          break;
        default:
          result = `Unknown agent: ${step.agent}`;
      }

      results.push(`Step ${step.step} (${step.agent}): ${result}`);
      console.log(`[Orchestrator] Step ${step.step} completed`);
    }

    const finalResult = results.join('\n\n');
    console.log('\n[Orchestrator] Plan execution completed');
    return finalResult;
  }

  /**
   * Execute Claude request with automatic rate limit retry
   */
  private async executeClaudeWithRetry(
    messages: Message[],
    toolResults: ToolResult[] = [],
    maxRetries: number = 3
  ): Promise<AgentResponse> {
    let lastError: any = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        if (toolResults.length > 0) {
          return await this.claude.executeWithTools(messages, toolResults);
        } else {
          return await this.claude.execute(messages);
        }
      } catch (error: any) {
        lastError = error;

        // Check if it's a rate limit error
        if (error.isRateLimit && error.retryAfter) {
          const retryAfter = error.retryAfter;
          console.log(`[Orchestrator] Rate limit hit. Waiting ${retryAfter} seconds before retry (attempt ${attempt}/${maxRetries})...`);

          // Broadcast rate limit info to UI
          if (typeof (global as any).rateLimitCallback === 'function') {
            (global as any).rateLimitCallback(retryAfter, attempt, maxRetries);
          }

          // Wait for the specified time
          await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));

          // Check for abort during wait
          if (this.aborted) {
            throw new Error('Execution aborted by user');
          }

          // Try again
          continue;
        }

        // If it's not a rate limit error, throw immediately
        throw error;
      }
    }

    // If we exhausted all retries, throw the last error
    throw lastError || new Error('Failed to execute Claude request after retries');
  }

  /**
   * Execute a task with Claude agent (with tool handling and rate limit retry)
   */
  async executeWithClaude(task: string, files?: FileAttachment[]): Promise<string> {
    // Check for abort at the start
    if (this.aborted) {
      throw new Error('Execution aborted by user');
    }

    // Simple approach: let Claude handle tool calls internally
    // We just provide tool executors and Claude manages its own message history
    const result = await this.executeClaudeWithToolHandling(task, files);
    return result;
  }

  /**
   * Truncate long tool results to prevent context overflow
   */
  private truncateToolResult(result: any, maxLength: number = 10000): string {
    const resultStr = typeof result === 'string' ? result : JSON.stringify(result);

    if (resultStr.length <= maxLength) {
      return resultStr;
    }

    const truncated = resultStr.substring(0, maxLength);
    const suffix = `\n\n[... skrócono ${resultStr.length - maxLength} znaków. Pełny wynik był za długi (${resultStr.length} znaków). Zadaj bardziej precyzyjne zapytanie aby uzyskać szczegóły.]`;

    return truncated + suffix;
  }

  /**
   * Execute Claude with automatic tool handling
   */
  private async executeClaudeWithToolHandling(task: string, files?: FileAttachment[]): Promise<string> {
    const messages: Message[] = [{ role: 'user', content: task, files }];
    let toolCallIterations = 0;
    const MAX_TOOL_ITERATIONS = 20;

    while (true) {
      // Check for abort
      if (this.aborted) {
        throw new Error('Execution aborted by user');
      }

      // Prevent infinite loops
      if (toolCallIterations >= MAX_TOOL_ITERATIONS) {
        throw new Error(`Maximum tool call iterations (${MAX_TOOL_ITERATIONS}) exceeded. Task may be too complex or model is stuck in a loop. Try breaking the task into smaller steps.`);
      }

      // Debug: Log message structure before calling Claude
      console.log(`[Orchestrator] Iteration ${toolCallIterations + 1}: Calling Claude with ${messages.length} messages: [${messages.map(m => m.role).join(', ')}]`);

      // Get response from Claude (with rate limit retry)
      const response = await this.executeClaudeWithRetry(messages);

      // If no tool calls, we're done
      if (!response.toolCalls || response.toolCalls.length === 0) {
        return response.content;
      }

      // We have tool calls - increment counter and process them
      toolCallIterations++;
      console.log(`[Orchestrator] Processing ${response.toolCalls.length} tool call(s) (iteration ${toolCallIterations})`);

      // Execute all tool calls
      const toolResults: ToolResult[] = [];
      for (const toolCall of response.toolCalls) {
        console.log(`[Claude] Tool call: ${toolCall.name}`);

        let toolResult: any;

        if (toolCall.name === 'invoke_gemini') {
          const geminiTask = toolCall.input.task as string;
          const context = toolCall.input.context as string | undefined;
          const fullTask = context ? `${geminiTask}\n\nContext: ${context}` : geminiTask;
          toolResult = await this.executeWithGemini(fullTask);
        } else if (toolCall.name === 'invoke_claude') {
          const claudeTask = toolCall.input.task as string;
          toolResult = await this.executeWithClaude(claudeTask);
        } else if (toolCall.name.startsWith('mcp_')) {
          toolResult = await this.claude.executeMCPTool(toolCall.name, toolCall.input);
        } else {
          toolResult = { error: `Unknown tool: ${toolCall.name}` };
        }

        // Track tool call for UI
        this.currentStepToolCalls.push({
          id: toolCall.id,
          name: toolCall.name,
          input: toolCall.input,
          result: toolResult
        });

        toolResults.push({
          toolCallId: toolCall.id,
          output: toolResult,
        });
      }

      // Build next messages array with proper structure for Claude API
      // The pattern must be: user -> assistant (with tool_use) -> user (with tool_result)

      // Add the assistant's response that contains tool_use blocks
      const assistantMessage = {
        role: 'assistant' as const,
        content: response.rawContent || response.content
      };
      console.log(`[Orchestrator] Adding assistant message with ${Array.isArray(assistantMessage.content) ? assistantMessage.content.length : 1} content block(s)`);
      messages.push(assistantMessage);

      // Add tool results as user message (with truncation to prevent context overflow)
      const userMessage = {
        role: 'user' as const,
        content: toolResults.map(tr => ({
          type: 'tool_result',
          tool_use_id: tr.toolCallId,
          content: this.truncateToolResult(tr.output, 10000)
        })) as any
      };
      console.log(`[Orchestrator] Adding user message with ${toolResults.length} tool result(s)`);
      messages.push(userMessage);

      console.log(`[Orchestrator] Messages array now has ${messages.length} messages with roles: [${messages.map(m => m.role).join(', ')}]`);

      // Loop continues - next iteration will call Claude with updated messages
    }
  }

  /**
   * Execute a task with Gemini agent (with tool handling)
   */
  async executeWithGemini(task: string, files?: FileAttachment[]): Promise<string> {
    // Check for abort at the start
    if (this.aborted) {
      throw new Error('Execution aborted by user');
    }

    const messages: Message[] = [{ role: 'user', content: task, files }];
    let response = await this.gemini.execute(messages);
    let result = response.content;

    // Handle tool calls
    while (response.toolCalls && response.toolCalls.length > 0) {
      const toolResults: ToolResult[] = [];

      for (const toolCall of response.toolCalls) {
        console.log(`[Gemini] Tool call: ${toolCall.name}`);

        let toolResult: any;

        if (toolCall.name === 'web_search') {
          // Simulate web search (in production, integrate with actual search API)
          toolResult = this.simulateWebSearch(
            toolCall.input.query as string,
            toolCall.input.num_results as number
          );
        } else if (toolCall.name === 'summarize') {
          // The summarization is handled by Gemini itself
          toolResult = { summary: 'Summarization requested' };
        } else {
          toolResult = { error: `Unknown tool: ${toolCall.name}` };
        }

        toolResults.push({
          toolCallId: toolCall.id,
          output: toolResult,
        });
      }

      // Add assistant's response with tool calls to messages
      messages.push({
        role: 'assistant',
        content: response.rawContent || result
      });

      // Continue conversation with tool results
      response = await this.gemini.executeWithTools(messages, toolResults);
      result = response.content;
    }

    return result;
  }

  /**
   * Execute a task with Manager agent
   */
  async executeWithManager(task: string): Promise<string> {
    // Check for abort at the start
    if (this.aborted) {
      throw new Error('Execution aborted by user');
    }

    const messages: Message[] = [{ role: 'user', content: task }];
    const response = await this.manager.execute(messages);
    return response.content;
  }

  /**
   * Execute a task with Ollama agent (with tool handling)
   */
  async executeWithOllama(task: string, files?: FileAttachment[]): Promise<string> {
    // Check if Ollama is configured
    if (!this.ollama) {
      throw new Error('Ollama agent is not configured. Add ollamaConfig or ollamaBaseUrl to orchestrator config.');
    }

    // Check for abort at the start
    if (this.aborted) {
      throw new Error('Execution aborted by user');
    }

    // Execute Ollama with automatic tool handling (similar to Claude)
    const result = await this.executeOllamaWithToolHandling(task, files);
    return result;
  }

  /**
   * Execute Ollama with automatic tool handling
   */
  private async executeOllamaWithToolHandling(task: string, files?: FileAttachment[]): Promise<string> {
    if (!this.ollama) {
      throw new Error('Ollama agent is not configured.');
    }

    const messages: Message[] = [{ role: 'user', content: task, files }];
    let toolCallIterations = 0;
    const MAX_TOOL_ITERATIONS = 20;
    let allToolCallsHistory: Array<{iteration: number, calls: Array<{name: string, input: any, result: any}>}> = [];

    while (true) {
      // Check for abort
      if (this.aborted) {
        throw new Error('Execution aborted by user');
      }

      // Prevent infinite loops
      if (toolCallIterations >= MAX_TOOL_ITERATIONS) {
        throw new Error(`Maximum tool call iterations (${MAX_TOOL_ITERATIONS}) exceeded. Task may be too complex or model is stuck in a loop.`);
      }

      console.log(`[Orchestrator] Ollama iteration ${toolCallIterations + 1}: Calling with ${messages.length} messages`);

      // Get response from Ollama
      const response = await this.ollama.execute(messages);

      // If no tool calls, we're done - return formatted result with history
      if (!response.toolCalls || response.toolCalls.length === 0) {
        // Format final response with tool calls history
        if (allToolCallsHistory.length > 0) {
          let formattedResponse = '';
          for (const iter of allToolCallsHistory) {
            formattedResponse += `\n=== Iteracja ${iter.iteration} - Wykonane narzędzia ===\n`;
            for (const call of iter.calls) {
              formattedResponse += `\n🛠️ ${call.name}\n`;
              formattedResponse += `Input: ${JSON.stringify(call.input, null, 2)}\n`;
              formattedResponse += `Result: ${JSON.stringify(call.result, null, 2)}\n`;
            }
          }
          formattedResponse += `\n=== Finalna odpowiedź LLM ===\n${response.content}`;
          return formattedResponse;
        }
        return response.content;
      }

      // We have tool calls - increment counter and process them
      toolCallIterations++;
      console.log(`[Orchestrator] Processing ${response.toolCalls.length} tool call(s) from Ollama (iteration ${toolCallIterations})`);

      // Execute all tool calls
      const toolResults: ToolResult[] = [];
      const currentIterationCalls: Array<{name: string, input: any, result: any}> = [];

      for (const toolCall of response.toolCalls) {
        console.log(`[Ollama] Tool call: ${toolCall.name}`);
        console.log(`[Ollama] Tool input:`, JSON.stringify(toolCall.input, null, 2));

        let toolResult: any;

        if (toolCall.name === 'invoke_gemini') {
          const geminiTask = toolCall.input.task as string;
          const context = toolCall.input.context as string | undefined;
          const fullTask = context ? `${geminiTask}\n\nContext: ${context}` : geminiTask;
          toolResult = await this.executeWithGemini(fullTask);
        } else if (toolCall.name === 'invoke_claude') {
          const claudeTask = toolCall.input.task as string;
          toolResult = await this.executeWithClaude(claudeTask);
        } else if (toolCall.name.startsWith('mcp_')) {
          // Execute MCP tool through Ollama agent
          console.log(`[Ollama] Executing MCP tool: ${toolCall.name}`);
          toolResult = await this.ollama.executeMCPTool(toolCall.name, toolCall.input);
          console.log(`[Ollama] MCP tool result:`, JSON.stringify(toolResult).substring(0, 500));
        } else {
          toolResult = { error: `Unknown tool: ${toolCall.name}` };
        }

        // Track tool call for history
        currentIterationCalls.push({
          name: toolCall.name,
          input: toolCall.input,
          result: toolResult
        });

        // Track tool call for UI
        this.currentStepToolCalls.push({
          id: toolCall.id,
          name: toolCall.name,
          input: toolCall.input,
          result: toolResult
        });

        toolResults.push({
          toolCallId: toolCall.id,
          output: toolResult,
        });
      }

      // Save this iteration's tool calls to history
      allToolCallsHistory.push({
        iteration: toolCallIterations,
        calls: currentIterationCalls
      });

      // Add assistant's response to messages
      messages.push({
        role: 'assistant',
        content: response.content
      });

      // Add tool results as user message
      const toolResultsText = toolResults
        .map((tr) => `Tool ${tr.toolCallId} (${response.toolCalls?.find(tc => tc.id === tr.toolCallId)?.name}) result:\n${JSON.stringify(tr.output, null, 2)}`)
        .join('\n\n');

      messages.push({
        role: 'user',
        content: `Otrzymano wyniki narzędzi:\n\n${toolResultsText}\n\nPrzeanalizuj wyniki i kontynuuj zadanie.`
      });

      console.log(`[Orchestrator] Messages array now has ${messages.length} messages`);

      // Loop continues - next iteration will call Ollama with updated messages
    }
  }

  /**
   * Direct chat with a specific agent
   */
  async chat(message: string, agent: 'claude' | 'gemini' | 'manager' | 'ollama' = 'claude'): Promise<string> {
    this.conversationHistory.push({ role: 'user', content: message });

    let response: string;
    switch (agent) {
      case 'claude':
        response = await this.executeWithClaude(message);
        break;
      case 'gemini':
        response = await this.executeWithGemini(message);
        break;
      case 'manager':
        response = await this.executeWithManager(message);
        break;
      case 'ollama':
        response = await this.executeWithOllama(message);
        break;
    }

    this.conversationHistory.push({ role: 'assistant', content: response });
    return response;
  }

  /**
   * Format plan for display
   */
  private formatPlan(plan: Plan): string {
    let output = `Goal: ${plan.goal}\n`;
    output += `Estimated Complexity: ${plan.estimatedComplexity}\n\n`;
    output += 'Execution Steps:\n';

    for (const step of plan.steps) {
      output += `\n${step.step}. ${step.description}\n`;
      output += `   Agent: ${step.agent}\n`;
      output += `   Reasoning: ${step.reasoning}\n`;
    }

    return output;
  }

  /**
   * Simulate web search (placeholder - integrate with real search API)
   */
  private simulateWebSearch(query: string, numResults: number = 5): any {
    return {
      query,
      results: [
        {
          title: `Result 1 for "${query}"`,
          url: 'https://example.com/1',
          snippet: 'This is a simulated search result. Integrate with a real search API for production use.',
        },
      ],
      note: 'This is a simulated search. Integrate with Google Search API, Bing API, or similar for production.',
    };
  }

  /**
   * Get conversation history
   */
  getHistory(): Message[] {
    return [...this.conversationHistory];
  }

  /**
   * Clear conversation history
   */
  clearHistory(): void {
    this.conversationHistory = [];
  }

  /**
   * Get and clear current step tool calls
   */
  getAndClearStepToolCalls(): Array<{ id: string; name: string; input: Record<string, any>; result?: any }> {
    const calls = [...this.currentStepToolCalls];
    this.currentStepToolCalls = [];
    return calls;
  }

  /**
   * Clear current step tool calls
   */
  clearStepToolCalls(): void {
    this.currentStepToolCalls = [];
  }
}
