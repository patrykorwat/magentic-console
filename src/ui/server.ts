#!/usr/bin/env node
import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { promises as fs } from 'fs';
import { MagenticOrchestrator } from '../orchestrator.js';
import { MCPServerConfig } from '../types/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Config and chat history paths
const CONFIG_FILE = path.join(process.cwd(), 'magentic-config.json');
const CHAT_HISTORY_DIR = path.join(process.cwd(), 'chat-history');
const EXECUTIONS_DIR = path.join(process.cwd(), 'executions');
const UPLOADS_DIR = path.join(process.cwd(), 'uploads');

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    await fs.mkdir(UPLOADS_DIR, { recursive: true });
    cb(null, UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + '-' + file.originalname);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
});

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));

// Parse MCP servers from environment or use hardcoded
let mcpServers: MCPServerConfig[] = [];
try {
  if (process.env.MCP_SERVERS) {
    // Remove surrounding quotes if present
    const cleanedMcpServers = process.env.MCP_SERVERS.replace(/^['"]|['"]$/g, '');
    mcpServers = JSON.parse(cleanedMcpServers);
    console.log(`[Server] Loaded ${mcpServers.length} MCP server(s) from .env`);
  }
} catch (error) {
  console.error('[Server] Failed to parse MCP_SERVERS from .env:', error);
  // No hardcoded fallback - use empty array
  mcpServers = [];
  console.log('[Server] No MCP servers configured. Add them in .env file.');
}

// Store configuration and orchestrator
let config = {
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  googleApiKey: process.env.GOOGLE_API_KEY || '',
  mcpServers,
  claudeConfig: {
    model: 'claude-3-7-sonnet-20250219',
    temperature: 1,
    maxTokens: 4096,
    customPrompt: undefined as string | undefined,
  },
  geminiConfig: {
    model: 'gemini-2.0-flash-exp',
    temperature: 1,
    maxTokens: 4096,
    customPrompt: undefined as string | undefined,
  },
  ollamaConfig: {
    model: 'llama3.2',
    temperature: 0.7,
    maxTokens: 4096,
    customPrompt: undefined as string | undefined,
  },
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
};

let orchestrator: MagenticOrchestrator | null = null;
let clients: Set<WebSocket> = new Set();

// Chat session management
interface FileAttachment {
  filename: string;
  originalName: string;
  path: string;
  mimeType: string;
  size: number;
  uploadedAt: string;
}

interface StepExecution {
  stepNumber: number;
  agent: string;
  model?: string; // Model używany do wykonania kroku
  description: string;
  query: string; // Zapytanie do modelu
  response: string; // Odpowiedź modelu
  status: 'executing' | 'completed' | 'error' | 'aborted';
  error?: string;
  startedAt: string;
  completedAt?: string;
}

interface ChatSession {
  id: string;
  agent: string;
  messages: Array<{
    role: string;
    content: string;
    timestamp: string;
    files?: FileAttachment[];
  }>;
  stepExecutions?: StepExecution[]; // Szczegóły wykonania każdego kroku
  createdAt: string;
  updatedAt: string;
}

let currentChatId: string | null = null;
let currentChatFiles: FileAttachment[] = []; // Files available for current execution context

// WebSocket connection
wss.on('connection', (ws) => {
  console.log('Client connected');
  clients.add(ws);

  ws.on('close', () => {
    console.log('Client disconnected');
    clients.delete(ws);
  });
});

// Broadcast to all connected clients
function broadcast(message: any) {
  const data = JSON.stringify(message);
  clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  });
}

// Load configuration from file (only model configs, API keys stay in env/browser)
async function loadConfigFromFile() {
  try {
    const data = await fs.readFile(CONFIG_FILE, 'utf-8');
    const savedConfig = JSON.parse(data);

    // Preserve existing MCP servers from initial config
    const existingMcpServers = config.mcpServers;

    // Only load model configurations (including custom prompts), keep API keys from env
    config = {
      anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
      googleApiKey: process.env.GOOGLE_API_KEY || '',
      mcpServers: existingMcpServers, // Preserve MCP servers from initial config
      claudeConfig: {
        ...config.claudeConfig,
        ...savedConfig.claudeConfig,
      },
      geminiConfig: {
        ...config.geminiConfig,
        ...savedConfig.geminiConfig,
      },
      ollamaConfig: {
        ...config.ollamaConfig,
        ...savedConfig.ollamaConfig,
      },
      ollamaBaseUrl: savedConfig.ollamaBaseUrl || config.ollamaBaseUrl,
    };

    console.log('✓ Loaded model configuration from file (API keys from environment/browser)');
    if (config.claudeConfig.customPrompt || config.geminiConfig.customPrompt) {
      console.log('✓ Custom prompts loaded');
    }
    return true;
  } catch (error) {
    // File doesn't exist or is invalid - use defaults
    console.log('No saved configuration found, using defaults');
    return false;
  }
}

// Save configuration to file (only model configs including custom prompts, not API keys or MCP servers)
async function saveConfigToFile() {
  try {
    const configToSave = {
      // Never save API keys or MCP servers - keep them in browser only
      // Save model configs including custom prompts
      claudeConfig: {
        model: config.claudeConfig.model,
        temperature: config.claudeConfig.temperature,
        maxTokens: config.claudeConfig.maxTokens,
        customPrompt: config.claudeConfig.customPrompt,
      },
      geminiConfig: {
        model: config.geminiConfig.model,
        temperature: config.geminiConfig.temperature,
        maxTokens: config.geminiConfig.maxTokens,
        customPrompt: config.geminiConfig.customPrompt,
      },
      ollamaConfig: {
        model: config.ollamaConfig.model,
        temperature: config.ollamaConfig.temperature,
        maxTokens: config.ollamaConfig.maxTokens,
        customPrompt: config.ollamaConfig.customPrompt,
      },
      ollamaBaseUrl: config.ollamaBaseUrl,
      savedAt: new Date().toISOString(),
    };

    await fs.writeFile(CONFIG_FILE, JSON.stringify(configToSave, null, 2), 'utf-8');
    console.log('✓ Model configuration saved to file');
    if (config.claudeConfig.customPrompt || config.geminiConfig.customPrompt) {
      console.log('✓ Custom prompts saved');
    }
    return true;
  } catch (error) {
    console.error('Failed to save configuration:', error);
    return false;
  }
}

// Chat history management functions
async function ensureChatHistoryDir() {
  try {
    await fs.mkdir(CHAT_HISTORY_DIR, { recursive: true });
  } catch (error) {
    console.error('Failed to create chat history directory:', error);
  }
}

async function saveChatSession(session: ChatSession) {
  try {
    await ensureChatHistoryDir();
    const filePath = path.join(CHAT_HISTORY_DIR, `${session.id}.json`);
    await fs.writeFile(filePath, JSON.stringify(session, null, 2), 'utf-8');
  } catch (error) {
    console.error('Failed to save chat session:', error);
  }
}

async function loadChatSession(chatId: string): Promise<ChatSession | null> {
  try {
    const filePath = path.join(CHAT_HISTORY_DIR, `${chatId}.json`);
    const data = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    return null;
  }
}

async function listChatSessions(): Promise<Array<{ id: string; agent: string; createdAt: string; updatedAt: string; messageCount: number }>> {
  try {
    await ensureChatHistoryDir();
    const files = await fs.readdir(CHAT_HISTORY_DIR);
    const sessions = [];

    for (const file of files) {
      if (file.endsWith('.json')) {
        try {
          const data = await fs.readFile(path.join(CHAT_HISTORY_DIR, file), 'utf-8');
          const session: ChatSession = JSON.parse(data);
          sessions.push({
            id: session.id,
            agent: session.agent,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
            messageCount: session.messages.length,
          });
        } catch (error) {
          // Skip invalid files
        }
      }
    }

    // Sort by updatedAt descending (most recent first)
    sessions.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    return sessions;
  } catch (error) {
    return [];
  }
}

function generateChatId(): string {
  return `chat-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

// Execution history management functions
async function ensureExecutionsDir() {
  try {
    await fs.mkdir(EXECUTIONS_DIR, { recursive: true });
  } catch (error) {
    console.error('Failed to create executions directory:', error);
  }
}

async function saveExecution(session: ChatSession) {
  try {
    await ensureExecutionsDir();
    const filePath = path.join(EXECUTIONS_DIR, `${session.id}.json`);
    await fs.writeFile(filePath, JSON.stringify(session, null, 2), 'utf-8');
  } catch (error) {
    console.error('Failed to save execution:', error);
  }
}

async function loadExecution(executionId: string): Promise<ChatSession | null> {
  try {
    const filePath = path.join(EXECUTIONS_DIR, `${executionId}.json`);
    const data = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    return null;
  }
}

async function listExecutions(): Promise<Array<{ id: string; task: string; createdAt: string; updatedAt: string; stepCount: number; aborted?: boolean }>> {
  try {
    await ensureExecutionsDir();
    const files = await fs.readdir(EXECUTIONS_DIR);
    const executions = [];

    for (const file of files) {
      if (file.endsWith('.json')) {
        try {
          const data = await fs.readFile(path.join(EXECUTIONS_DIR, file), 'utf-8');
          const session: ChatSession = JSON.parse(data);

          // Get task from first user message
          const taskMessage = session.messages.find(m => m.role === 'user');
          const task = taskMessage?.content || 'Nieznane zadanie';

          // Count step messages (exclude plan and final result)
          const stepCount = session.messages.filter(m =>
            m.role === 'assistant' && m.content.startsWith('Krok ')
          ).length;

          // Check if aborted
          const aborted = session.messages.some(m =>
            m.content.includes('[Wykonanie przerwane')
          );

          executions.push({
            id: session.id,
            task: task.length > 100 ? task.substring(0, 100) + '...' : task,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
            stepCount,
            aborted,
          });
        } catch (error) {
          // Skip invalid files
        }
      }
    }

    // Sort by updatedAt descending (most recent first)
    executions.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    return executions;
  } catch (error) {
    return [];
  }
}

function generateExecutionId(): string {
  return `exec-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

// Initialize orchestrator
async function initOrchestrator() {
  if (orchestrator) {
    await orchestrator.cleanup();
  }

  orchestrator = new MagenticOrchestrator({
    anthropicApiKey: config.anthropicApiKey,
    googleApiKey: config.googleApiKey,
    mcpServers: config.mcpServers,
    claudeConfig: config.claudeConfig,
    geminiConfig: config.geminiConfig,
    ollamaConfig: config.ollamaConfig,
    ollamaBaseUrl: config.ollamaBaseUrl,
  });

  await orchestrator.initialize();

  // Setup rate limit callback
  (global as any).rateLimitCallback = (retryAfter: number, attempt: number, maxRetries: number) => {
    console.log(`[Server] Rate limit callback: retryAfter=${retryAfter}s, attempt=${attempt}/${maxRetries}`);
    broadcast({
      type: 'rate_limit_wait',
      retryAfter,
      attempt,
      maxRetries,
    });
  };

  broadcast({ type: 'status', message: 'Orchestrator initialized' });
}

// API Routes

// Get available Claude models from Anthropic API
app.get('/api/models/claude', async (req, res) => {
  try {
    if (!config.anthropicApiKey) {
      return res.json({ models: [] });
    }

    const response = await fetch('https://api.anthropic.com/v1/models', {
      headers: {
        'x-api-key': config.anthropicApiKey,
        'anthropic-version': '2023-06-01',
      },
    });

    if (!response.ok) {
      console.error('Failed to fetch Claude models:', response.statusText);
      return res.json({ models: [] });
    }

    const data: any = await response.json();

    // Filter and categorize models
    const models = data.data || [];
    const categorized = {
      sonnet: models.filter((m: any) => m.id.includes('sonnet')).sort((a: any, b: any) => b.created_at - a.created_at),
      opus: models.filter((m: any) => m.id.includes('opus')).sort((a: any, b: any) => b.created_at - a.created_at),
      haiku: models.filter((m: any) => m.id.includes('haiku')).sort((a: any, b: any) => b.created_at - a.created_at),
    };

    res.json({
      models: {
        latest: {
          sonnet: categorized.sonnet[0]?.id || 'claude-3-7-sonnet-20250219',
          opus: categorized.opus[0]?.id || 'claude-3-opus-20240229',
          haiku: categorized.haiku[0]?.id || 'claude-3-5-haiku-20241022',
        },
        all: {
          sonnet: categorized.sonnet.map((m: any) => ({ id: m.id, name: m.display_name || m.id })),
          opus: categorized.opus.map((m: any) => ({ id: m.id, name: m.display_name || m.id })),
          haiku: categorized.haiku.map((m: any) => ({ id: m.id, name: m.display_name || m.id })),
        },
      },
    });
  } catch (error: any) {
    console.error('Error fetching Claude models:', error);
    res.status(500).json({ error: error.message, models: [] });
  }
});

// Get available Gemini models from Google API
app.get('/api/models/gemini', async (req, res) => {
  try {
    if (!config.googleApiKey) {
      return res.json({ models: [] });
    }

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${config.googleApiKey}`);

    if (!response.ok) {
      console.error('Failed to fetch Gemini models:', response.statusText);
      return res.json({ models: [] });
    }

    const data: any = await response.json();

    // Filter only generative models and sort by name
    const models = (data.models || [])
      .filter((m: any) =>
        m.supportedGenerationMethods?.includes('generateContent') &&
        m.name.includes('models/gemini')
      )
      .map((m: any) => ({
        id: m.name.replace('models/', ''),
        name: m.displayName || m.name.replace('models/', ''),
        description: m.description || '',
      }))
      .sort((a: any, b: any) => {
        // Sort by version number (higher first)
        const versionA = parseFloat(a.id.match(/\d+\.\d+/)?.[0] || '0');
        const versionB = parseFloat(b.id.match(/\d+\.\d+/)?.[0] || '0');
        if (versionB !== versionA) return versionB - versionA;

        // Then by name (pro before flash)
        if (a.id.includes('pro') && !b.id.includes('pro')) return -1;
        if (!a.id.includes('pro') && b.id.includes('pro')) return 1;

        return b.id.localeCompare(a.id);
      });

    res.json({ models });
  } catch (error: any) {
    console.error('Error fetching Gemini models:', error);
    res.status(500).json({ error: error.message, models: [] });
  }
});

// Get Ollama models from ollama-models.json
app.get('/api/models/ollama', async (req, res) => {
  try {
    const configPath = path.join(process.cwd(), 'ollama-models.json');
    const data = await fs.readFile(configPath, 'utf-8');
    const config = JSON.parse(data);
    res.json({ models: config.models || [], defaultModel: config.defaultModel });
  } catch (error: any) {
    console.error('Error loading ollama-models.json:', error);
    // Return default models if file doesn't exist
    res.json({
      models: [
        {
          id: 'qwen2.5:7b',
          name: 'Qwen 2.5 (7B)',
          description: 'Najlepszy balans jakości i szybkości',
          recommended: true
        },
        {
          id: 'llama3.2:3b',
          name: 'Llama 3.2 (3B)',
          description: 'Bardzo szybki - proste zadania'
        }
      ],
      defaultModel: 'qwen2.5:7b'
    });
  }
});

// Get current configuration
app.get('/api/config', (req, res) => {
  res.json({
    ...config,
    anthropicApiKey: config.anthropicApiKey ? '***' : '',
    googleApiKey: config.googleApiKey ? '***' : '',
  });
});

// Get MCP servers and their tools
app.get('/api/mcp-servers', async (req, res) => {
  try {
    if (!orchestrator) {
      return res.json({ servers: [] });
    }

    const claude = orchestrator['claude'];
    if (!claude) {
      return res.json({ servers: [] });
    }

    // Get all tools from Claude agent
    const allTools = claude.getTools();

    const serverInfo = config.mcpServers.map(server => {
      // Count tools that belong to this MCP server
      const serverTools = allTools.filter(t => t.name.startsWith(`mcp_${server.name}_`));

      return {
        name: server.name,
        command: server.command,
        toolCount: serverTools.length,
        tools: serverTools.map(t => ({
          name: t.name.replace(`mcp_${server.name}_`, ''),
          description: t.description
        }))
      };
    });

    res.json({ servers: serverInfo });
  } catch (error: any) {
    console.error('[Server] Error getting MCP servers:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update configuration (model settings only)
app.post('/api/config', async (req, res) => {
  try {
    const updates = req.body;

    // Only update model configurations
    if (updates.claudeConfig) {
      config.claudeConfig = { ...config.claudeConfig, ...updates.claudeConfig };
    }
    if (updates.geminiConfig) {
      config.geminiConfig = { ...config.geminiConfig, ...updates.geminiConfig };
    }

    // Save model configuration to file
    await saveConfigToFile();

    // Reinitialize orchestrator with current API keys from env
    await initOrchestrator();

    res.json({ success: true, message: 'Model configuration updated' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get agent capabilities
app.get('/api/agents', (req, res) => {
  if (!orchestrator) {
    return res.status(400).json({ error: 'Orchestrator not initialized' });
  }

  const agents = [
    {
      name: 'Manager',
      model: 'claude-3-7-sonnet-20250219 (Opus 4)',
      capabilities: ['planning', 'orchestration', 'delegation', 'coordination'],
      description: 'Creates execution plans and orchestrates tasks between agents',
    },
    {
      name: 'Claude',
      model: config.claudeConfig.model,
      capabilities: [
        'deep_reasoning',
        'code_analysis',
        'code_generation',
        'complex_problem_solving',
        'technical_writing',
        'pdf_reading',
      ],
      description: 'Specialized in deep reasoning, code challenges, and PDF analysis',
      tools: orchestrator['claude'].getTools().map((t) => t.name),
    },
    {
      name: 'Gemini',
      model: config.geminiConfig.model,
      capabilities: [
        'web_search',
        'summarization',
        'information_retrieval',
        'data_synthesis',
        'quick_analysis',
      ],
      description: 'Specialized in web search and text summarization',
      tools: orchestrator['gemini'].getTools().map((t) => t.name),
    },
  ];

  // Add Ollama if configured
  if (orchestrator['ollama']) {
    agents.push({
      name: 'Ollama',
      model: config.ollamaConfig.model,
      capabilities: [
        'local_inference',
        'privacy_focused',
        'offline_capable',
        'quick_analysis',
        'cost_free',
      ],
      description: 'Local open-source model running offline (free)',
      tools: orchestrator['ollama'].getTools().map((t) => t.name),
    });
  }

  res.json({ agents });
});

// Upload files
app.post('/api/upload', upload.array('files', 10), async (req, res) => {
  try {
    if (!req.files || !Array.isArray(req.files)) {
      return res.status(400).json({ error: 'No files uploaded' });
    }

    const uploadedFiles: FileAttachment[] = req.files.map((file) => ({
      filename: file.filename,
      originalName: file.originalname,
      path: path.join(UPLOADS_DIR, file.filename), // Absolute filesystem path for reading
      mimeType: file.mimetype,
      size: file.size,
      uploadedAt: new Date().toISOString(),
    }));

    // Add to current chat files
    currentChatFiles.push(...uploadedFiles);

    res.json({ files: uploadedFiles });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Chat with an agent
app.post('/api/chat', async (req, res) => {
  try {
    if (!orchestrator) {
      return res.status(400).json({ error: 'Orchestrator not initialized' });
    }

    const { message, agent, chatId, fileIds } = req.body;

    if (!message || !agent) {
      return res.status(400).json({ error: 'Message and agent are required' });
    }

    // Load or create chat session
    let session: ChatSession;
    if (chatId && chatId !== 'new') {
      const existing = await loadChatSession(chatId);
      if (existing) {
        session = existing;
      } else {
        session = {
          id: chatId,
          agent,
          messages: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      }
    } else {
      const newId = generateChatId();
      session = {
        id: newId,
        agent,
        messages: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      currentChatId = newId;
    }

    // Get files for this message
    const messageFiles = fileIds
      ? currentChatFiles.filter((f) => fileIds.includes(f.filename))
      : [];

    // Build message with file context
    let fullMessage = message;
    if (messageFiles.length > 0) {
      const fileContext = messageFiles.map((f) => {
        return `\n\nPlik załączony: ${f.originalName} (${f.mimeType}, ${(f.size / 1024).toFixed(2)}KB)\nŚcieżka: ${f.path}`;
      }).join('');
      fullMessage = message + fileContext + '\n\n[Informacja: Pliki są dostępne w systemie plików pod podanymi ścieżkami]';
    }

    // Add user message to session
    session.messages.push({
      role: 'user',
      content: message,
      timestamp: new Date().toISOString(),
      files: messageFiles.length > 0 ? messageFiles : undefined,
    });

    broadcast({
      type: 'chat_start',
      agent,
      message,
      chatId: session.id,
      files: messageFiles,
    });

    const response = await orchestrator.chat(fullMessage, agent);

    // Add assistant response to session
    session.messages.push({
      role: 'assistant',
      content: response,
      timestamp: new Date().toISOString(),
    });

    session.updatedAt = new Date().toISOString();
    await saveChatSession(session);

    broadcast({
      type: 'chat_complete',
      agent,
      response,
      chatId: session.id,
    });

    res.json({ response, chatId: session.id });
  } catch (error: any) {
    broadcast({
      type: 'error',
      error: error.message,
    });
    res.status(500).json({ error: error.message });
  }
});

// Create a plan
app.post('/api/plan', async (req, res) => {
  try {
    if (!orchestrator) {
      return res.status(400).json({ error: 'Orchestrator not initialized' });
    }

    const { task } = req.body;

    if (!task) {
      return res.status(400).json({ error: 'Task is required' });
    }

    broadcast({
      type: 'plan_start',
      task,
    });

    const plan = await orchestrator['manager'].createPlan(task);

    broadcast({
      type: 'plan_created',
      plan,
    });

    res.json({ plan });
  } catch (error: any) {
    broadcast({
      type: 'error',
      error: error.message,
    });
    res.status(500).json({ error: error.message });
  }
});

// Execute a task with planning
app.post('/api/execute', async (req, res) => {
  // Declare session outside try block so it's accessible in catch
  let session: ChatSession | null = null;

  try {
    if (!orchestrator) {
      return res.status(400).json({ error: 'Orchestrator not initialized' });
    }

    const { task, fileIds } = req.body;

    if (!task) {
      return res.status(400).json({ error: 'Task is required' });
    }

    // Reset abort flag
    if (orchestrator) {
      orchestrator.aborted = false;
    }

    // Create new execution session
    const sessionId = generateExecutionId();
    session = {
      id: sessionId,
      agent: 'manager',
      messages: [],
      stepExecutions: [], // Inicjalizuj tablicę szczegółów kroków
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // Get files for this execution
    const taskFiles = fileIds && fileIds.length > 0
      ? currentChatFiles.filter((f) => fileIds.includes(f.filename))
      : [];

    console.log(`[Server] Task files: ${taskFiles.length} file(s)`);
    if (taskFiles.length > 0) {
      console.log('[Server] Files:', taskFiles.map(f => f.originalName).join(', '));
    }

    // Build task with file context
    let fullTask = task;
    if (taskFiles.length > 0) {
      const fileContext = taskFiles.map((f) => {
        return `\n- ${f.originalName} (${f.mimeType})`;
      }).join('');
      fullTask = task + '\n\nDostępne pliki:' + fileContext + '\n\n[Informacja: Pliki są dostępne lokalnie i mogą być przekazywane między agentami]';
      console.log(`[Server] Full task with files:\n${fullTask}`);
    }

    // Add user task to session
    session.messages.push({
      role: 'user',
      content: task,
      timestamp: new Date().toISOString(),
      files: taskFiles.length > 0 ? taskFiles : undefined,
    });

    broadcast({
      type: 'execution_start',
      task: fullTask,
    });

    // Check if aborted before creating plan
    if (orchestrator.aborted) {
      console.log('[Server] Execution aborted before plan creation');
      broadcast({ type: 'execution_aborted' });
      return res.json({ success: true, aborted: true });
    }

    // Create plan - pass fullTask which includes file context
    const plan = await orchestrator['manager'].createPlan(fullTask);

    // Check if aborted after plan creation
    if (orchestrator.aborted) {
      console.log('[Server] Execution aborted after plan creation');
      broadcast({ type: 'execution_aborted' });
      return res.json({ success: true, aborted: true });
    }

    // Debug: Log plan steps with model field
    console.log('[Server] Plan created with steps:');
    plan.steps.forEach(step => {
      console.log(`  Step ${step.step}: agent=${step.agent}, model=${step.model || 'NOT SET'}`);
    });

    broadcast({
      type: 'plan_created',
      plan,
    });

    // Add plan to session as assistant message
    session.messages.push({
      role: 'assistant',
      content: `Plan wykonania:\n${JSON.stringify(plan, null, 2)}`,
      timestamp: new Date().toISOString(),
    });

    // Execute plan step by step
    const results: string[] = [];
    for (const step of plan.steps) {
      // Check if aborted before each step
      if (orchestrator.aborted) {
        console.log(`[Server] Execution aborted before step ${step.step}`);
        broadcast({ type: 'execution_aborted' });
        return res.json({ success: true, aborted: true, results });
      }

      // Build query that will be sent to agent (before step execution)
      let stepQuery = step.description;
      if (step.requiredFiles && step.requiredFiles.length > 0 && taskFiles.length > 0) {
        const stepFiles = taskFiles.filter(f =>
          step.requiredFiles!.some(rf => f.originalName === rf || f.filename === rf)
        );
        if (stepFiles.length > 0) {
          const fileContext = stepFiles.map((f) => {
            return `\n- ${f.originalName} (${f.mimeType})`;
          }).join('');
          stepQuery += '\n\nPliki:' + fileContext;
        }
      }

      // Create step execution record
      const stepExecution: StepExecution = {
        stepNumber: step.step,
        agent: step.agent,
        model: step.model, // Model używany do wykonania kroku
        description: step.description,
        query: stepQuery, // Zapytanie do agenta (z plikami jeśli są wymagane)
        response: '',
        status: 'executing',
        startedAt: new Date().toISOString(),
      };

      session.stepExecutions!.push(stepExecution);

      broadcast({
        type: 'step_start',
        step,
        stepExecution,
      });

      let result: string;
      try {
        // Build task for this step, including context from previous steps
        let stepTask = step.description;

        // Add context from previous steps if this is not the first step
        if (results.length > 0) {
          stepTask += '\n\n--- KONTEKST Z POPRZEDNICH KROKÓW ---\n';
          for (let i = 0; i < results.length; i++) {
            const prevStep = plan.steps[i];
            stepTask += `\nKrok ${prevStep.step} (${prevStep.agent}): ${prevStep.description}\nWynik: ${results[i]}\n`;
          }
          stepTask += '--- KONIEC KONTEKSTU ---\n';
        }

        let stepFiles: FileAttachment[] = [];

        console.log(`[Server] Step ${step.step}: requiredFiles =`, step.requiredFiles);
        if (step.requiredFiles && step.requiredFiles.length > 0 && taskFiles.length > 0) {
          // Filter to only the files required for this step
          stepFiles = taskFiles.filter(f =>
            step.requiredFiles!.some(rf => f.originalName === rf || f.filename === rf)
          );

          console.log(`[Server] Step ${step.step}: Found ${stepFiles.length} matching files`);
          if (stepFiles.length > 0) {
            console.log(`[Server] Step ${step.step}: Will pass ${stepFiles.length} file(s) directly to agent:`, stepFiles.map(f => f.originalName).join(', '));

            // WARNING: Only Claude can receive files directly
            if (step.agent !== 'claude' && stepFiles.length > 0) {
              console.warn(`[Server] ⚠️  WARNING: Step ${step.step} assigned to ${step.agent} but has files! Only Claude can read files. Files will be ignored.`);
              console.warn(`[Server] ⚠️  Manager made an error - ${step.agent} cannot process files: ${stepFiles.map(f => f.originalName).join(', ')}`);
              stepFiles = []; // Clear files - Ollama/Gemini cannot handle them
            }
          }
        }

        switch (step.agent) {
          case 'claude':
            // Set Claude model if specified in plan step
            if (step.model) {
              console.log(`[Server] Step ${step.step}: Setting Claude model to ${step.model}`);
              orchestrator.setClaudeModel(step.model);
            }
            result = await orchestrator['executeWithClaude'](stepTask, stepFiles.length > 0 ? stepFiles : undefined);
            break;
          case 'gemini':
            result = await orchestrator['executeWithGemini'](stepTask, stepFiles.length > 0 ? stepFiles : undefined);
            break;
          case 'ollama':
            result = await orchestrator['executeWithOllama'](stepTask, stepFiles.length > 0 ? stepFiles : undefined);
            break;
          case 'manager':
            result = await orchestrator['executeWithManager'](stepTask);
            break;
          default:
            result = `Unknown agent: ${step.agent}`;
        }

        results.push(result);

        // Update step execution with result
        stepExecution.response = result;
        stepExecution.status = 'completed';
        stepExecution.completedAt = new Date().toISOString();

        // Save execution state after each successful step
        session.updatedAt = new Date().toISOString();
        await saveExecution(session);

      } catch (error: any) {
        // Update step execution with error
        stepExecution.status = error.message === 'Execution aborted by user' ? 'aborted' : 'error';
        stepExecution.error = error.message;
        stepExecution.completedAt = new Date().toISOString();

        // Save execution state even on error
        session.updatedAt = new Date().toISOString();
        await saveExecution(session);

        // Check if it was an abort error
        if (error.message === 'Execution aborted by user') {
          session.messages.push({
            role: 'assistant',
            content: '[Wykonanie przerwane przez użytkownika]',
            timestamp: new Date().toISOString(),
          });
          session.updatedAt = new Date().toISOString();
          await saveExecution(session);

          broadcast({
            type: 'execution_aborted',
            message: 'Wykonanie zostało przerwane przez użytkownika',
          });
          return res.json({
            plan,
            result: results.join('\n\n') + '\n\n[Wykonanie przerwane]',
            aborted: true,
            sessionId: session.id,
          });
        }
        throw error; // Re-throw if it's not an abort error
      }

      // Add step result to session
      session.messages.push({
        role: 'assistant',
        content: `Krok ${step.step} (${step.agent}): ${step.description}\n\nWynik:\n${result}`,
        timestamp: new Date().toISOString(),
      });

      broadcast({
        type: 'step_complete',
        step,
        result,
        stepExecution,
      });
    }

    const finalResult = results.join('\n\n');

    // Add final result to session
    session.messages.push({
      role: 'assistant',
      content: `Wykonanie zakończone:\n\n${finalResult}`,
      timestamp: new Date().toISOString(),
    });

    // Save the complete execution
    session.updatedAt = new Date().toISOString();
    await saveExecution(session);

    broadcast({
      type: 'execution_complete',
      result: finalResult,
    });

    res.json({ plan, result: finalResult, sessionId: session.id });
  } catch (error: any) {
    // Reset abort flag
    if (orchestrator) {
      orchestrator.aborted = false;
    }

    // Extract error message - handle both simple errors and API error objects
    let errorMessage = error.message || 'Unknown error';
    let fullErrorDetails = errorMessage;

    // If error has response data (from Anthropic API), extract details
    if (error.response?.data) {
      const apiError = error.response.data;
      if (apiError.error?.message) {
        errorMessage = apiError.error.message;
        fullErrorDetails = JSON.stringify(apiError, null, 2);
      }
    } else if (typeof error === 'string') {
      errorMessage = error;
      fullErrorDetails = error;
    }

    // Save execution state even on error
    if (session) {
      session.messages.push({
        role: 'assistant',
        content: `[Błąd wykonania]: ${errorMessage}\n\nSzczegóły:\n${fullErrorDetails}`,
        timestamp: new Date().toISOString(),
      });
      session.updatedAt = new Date().toISOString();

      // Log that we're saving the error
      console.log(`[Server] Saving execution ${session.id} with error: ${errorMessage}`);
      await saveExecution(session);
      console.log(`[Server] Execution ${session.id} saved to executions/${session.id}.json`);
    }

    // Broadcast error and stop execution
    broadcast({
      type: 'execution_error',
      error: errorMessage,
    });

    broadcast({
      type: 'error',
      error: errorMessage,
    });

    res.status(500).json({ error: errorMessage, details: fullErrorDetails });
  }
});

// Get conversation history
app.get('/api/history', (req, res) => {
  if (!orchestrator) {
    return res.status(400).json({ error: 'Orchestrator not initialized' });
  }

  res.json({ history: orchestrator.getHistory() });
});

// Clear history
app.post('/api/history/clear', (req, res) => {
  if (!orchestrator) {
    return res.status(400).json({ error: 'Orchestrator not initialized' });
  }

  orchestrator.clearHistory();
  broadcast({ type: 'history_cleared' });
  res.json({ success: true });
});

// Get list of chat sessions
app.get('/api/chats', async (req, res) => {
  try {
    const sessions = await listChatSessions();
    res.json({ sessions });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get specific chat session
app.get('/api/chats/:chatId', async (req, res) => {
  try {
    const session = await loadChatSession(req.params.chatId);
    if (!session) {
      return res.status(404).json({ error: 'Chat session not found' });
    }
    res.json({ session });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Create new chat session
app.post('/api/chats/new', (req, res) => {
  try {
    const { agent } = req.body;
    const newId = generateChatId();
    currentChatId = newId;

    broadcast({ type: 'new_chat', chatId: newId, agent });
    res.json({ chatId: newId });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Abort task execution
app.post('/api/execute/abort', (req, res) => {
  try {
    if (orchestrator) {
      orchestrator.aborted = true;
    }
    broadcast({ type: 'execution_aborted' });
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get list of all executions
app.get('/api/executions', async (req, res) => {
  try {
    const executions = await listExecutions();
    res.json({ executions });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get specific execution by ID
app.get('/api/executions/:executionId', async (req, res) => {
  try {
    const { executionId } = req.params;
    const execution = await loadExecution(executionId);
    if (!execution) {
      return res.status(404).json({ error: 'Execution not found' });
    }
    res.json({ execution });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Serve index.html for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
const PORT = process.env.PORT || 3001;
server.listen(PORT, async () => {
  console.log(`\n╔════════════════════════════════════════════════════════╗`);
  console.log(`║    Magentic Agent Orchestrator - Web UI               ║`);
  console.log(`╚════════════════════════════════════════════════════════╝\n`);
  console.log(`🌐 Server running at: http://localhost:${PORT}`);
  console.log(`🔌 WebSocket available for real-time updates\n`);

  // Load saved configuration from file
  await loadConfigFromFile();

  // Initialize orchestrator if API keys are available
  if (config.anthropicApiKey && config.googleApiKey) {
    try {
      await initOrchestrator();
      console.log('✓ Orchestrator initialized\n');
    } catch (error) {
      console.error('⚠ Failed to initialize orchestrator:', error);
      console.log('  Configure API keys in the UI\n');
    }
  } else {
    console.log('⚠ API keys not found');
    console.log('  Configure them in the UI at http://localhost:' + PORT + '\n');
  }
});

// Cleanup on exit
process.on('SIGTERM', async () => {
  if (orchestrator) {
    await orchestrator.cleanup();
  }
  server.close();
});
