/**
 * System prompts loader for different agent types
 * Prompts are loaded from magentic-config.json configuration file
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface MagenticConfig {
  agentDefaultPrompts?: {
    mlx?: string;
    claude?: string;
    ollama?: string;
    gemini?: string;
  };
  // ... other config fields
}

let cachedConfig: MagenticConfig | null = null;

/**
 * Load configuration from magentic-config.json file
 * Falls back to magentic-config.json.example if magentic-config.json doesn't exist
 */
function loadConfig(): MagenticConfig {
  if (cachedConfig) {
    return cachedConfig;
  }

  const projectRoot = join(__dirname, '../..');

  try {
    // Try to load magentic-config.json first
    const configPath = join(projectRoot, 'magentic-config.json');
    const content = readFileSync(configPath, 'utf-8');
    cachedConfig = JSON.parse(content);
    return cachedConfig!;
  } catch (error) {
    // Fall back to magentic-config.json.example
    try {
      const examplePath = join(projectRoot, 'magentic-config.json.example');
      const content = readFileSync(examplePath, 'utf-8');
      cachedConfig = JSON.parse(content);
      console.warn('[Prompts] magentic-config.json not found, using magentic-config.json.example as fallback');
      return cachedConfig!;
    } catch (fallbackError) {
      console.error('[Prompts] Failed to load magentic configuration:', fallbackError);
      return {};
    }
  }
}

/**
 * Get MLX agent default prompt
 */
export function getMLXDefaultPrompt(): string {
  const config = loadConfig();
  return config.agentDefaultPrompts?.mlx || 'You are a helpful AI assistant.';
}

/**
 * Get Claude agent default prompt
 */
export function getClaudeDefaultPrompt(): string {
  const config = loadConfig();
  return config.agentDefaultPrompts?.claude || 'You are a helpful AI assistant.';
}

/**
 * Get Ollama agent default prompt
 */
export function getOllamaDefaultPrompt(): string {
  const config = loadConfig();
  return config.agentDefaultPrompts?.ollama || 'You are a helpful AI assistant.';
}

/**
 * Get Gemini agent default prompt
 */
export function getGeminiDefaultPrompt(): string {
  const config = loadConfig();
  return config.agentDefaultPrompts?.gemini || 'You are a helpful AI assistant.';
}

/**
 * Reload prompts from disk (useful for hot-reloading config changes)
 */
export function reloadPrompts(): void {
  cachedConfig = null;
}
