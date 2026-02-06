// WebSocket connection
let ws = null;
let currentPlan = null;
let stepResults = {};
let uploadedFiles = []; // Currently uploaded files for this session

// Initialize WebSocket
function initWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${window.location.host}`);

    ws.onopen = () => {
        updateStatus('connected');
        addLog('WebSocket połączony', 'success');
    };

    ws.onclose = () => {
        updateStatus('disconnected');
        addLog('WebSocket rozłączony', 'error');
        // Reconnect after 3 seconds
        setTimeout(initWebSocket, 3000);
    };

    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        handleWebSocketMessage(data);
    };

    ws.onerror = (error) => {
        addLog('Błąd WebSocket', 'error');
        console.error('WebSocket error:', error);
    };
}

// Handle WebSocket messages
function handleWebSocketMessage(data) {
    addLog(`${data.type}: ${JSON.stringify(data)}`, 'info');

    switch (data.type) {
        case 'status':
            addLog(data.message, 'success');
            break;

        case 'chat_start':
            addChatMessage('system', `${data.agent} is thinking...`);
            break;

        case 'chat_complete':
            addChatMessage(data.agent, data.response);
            break;

        case 'plan_created':
            currentPlan = data.plan;
            showExecutionOutput();
            displayPlanRealtime(data.plan);
            addLog('Plan utworzony', 'success');
            break;

        case 'step_start':
            updateStepStatusRealtime(data.stepExecution.stepNumber, 'executing', data.stepExecution);
            addLog(`Wykonywanie kroku ${data.stepExecution.stepNumber} z ${data.stepExecution.agent}`, 'info');
            break;

        case 'step_complete':
            stepResults[data.step.step] = data.result;
            // Add tool calls to step data if available
            const stepDataWithTools = { ...data.step };
            if (data.toolCalls && data.toolCalls.length > 0) {
                stepDataWithTools.toolCalls = data.toolCalls;
            }
            updateStepStatusRealtime(data.step.step, 'completed', stepDataWithTools, data.result);
            addLog(`Krok ${data.step.step} zakończony${data.toolCalls ? ` (${data.toolCalls.length} tool calls)` : ''}`, 'success');
            break;

        case 'execution_start':
            showExecutionSpinner();
            document.getElementById('execute-btn').disabled = true;
            document.getElementById('abort-btn').style.display = 'inline-block';
            addLog(`Rozpoczęcie wykonywania zadania`, 'info');
            break;

        case 'execution_complete':
            hideExecutionSpinner();
            displayFinalResult(data.result);
            document.getElementById('execute-btn').disabled = false;
            document.getElementById('abort-btn').style.display = 'none';
            addLog('Wykonanie zadania zakończone', 'success');
            // Refresh history
            loadExecutionsHistory();
            break;

        case 'execution_aborted':
            hideExecutionSpinner();
            document.getElementById('execute-btn').disabled = false;
            document.getElementById('abort-btn').style.display = 'none';
            addLog('Wykonanie przerwane przez użytkownika', 'warning');
            alert('Wykonanie zostało przerwane');
            // Refresh history
            loadExecutionsHistory();
            break;

        case 'rate_limit_wait':
            const rateLimitMessage = `⏳ Rate limit przekroczony. Oczekiwanie ${data.retryAfter} sekund (próba ${data.attempt}/${data.maxRetries})...`;
            addLog(rateLimitMessage, 'warning');

            // Show rate limit notification in execution output
            const rateLimitDiv = document.createElement('div');
            rateLimitDiv.className = 'step-item';
            rateLimitDiv.style.background = '#fff3cd';
            rateLimitDiv.style.borderLeft = '4px solid #ffc107';
            rateLimitDiv.id = 'rate-limit-notification';
            rateLimitDiv.innerHTML = `
                <div style="display: flex; align-items: center; gap: 10px;">
                    <div class="spinner"></div>
                    <div>
                        <strong>⏳ Limit API przekroczony</strong>
                        <div style="margin-top: 8px; font-size: 14px; color: #666;">
                            Automatyczne ponowienie za <strong id="rate-limit-countdown">${data.retryAfter}</strong> sekund
                            <br>Próba ${data.attempt} z ${data.maxRetries}
                        </div>
                    </div>
                </div>
            `;

            const planSteps = document.getElementById('plan-steps');
            if (planSteps) {
                // Remove old rate limit notification if exists
                const oldNotification = document.getElementById('rate-limit-notification');
                if (oldNotification) oldNotification.remove();

                planSteps.appendChild(rateLimitDiv);

                // Start countdown
                let remaining = data.retryAfter;
                const countdownInterval = setInterval(() => {
                    remaining--;
                    const countdownEl = document.getElementById('rate-limit-countdown');
                    if (countdownEl) {
                        countdownEl.textContent = remaining;
                    }

                    if (remaining <= 0) {
                        clearInterval(countdownInterval);
                        // Remove notification after countdown
                        setTimeout(() => {
                            const notification = document.getElementById('rate-limit-notification');
                            if (notification) notification.remove();
                        }, 1000);
                    }
                }, 1000);
            }
            break;

        case 'execution_error':
            hideExecutionSpinner();
            document.getElementById('execute-btn').disabled = false;
            document.getElementById('abort-btn').style.display = 'none';
            addLog(`Błąd wykonania: ${data.error}`, 'error');

            // Show error in UI
            const errorDiv = document.createElement('div');
            errorDiv.className = 'step-item error';
            errorDiv.innerHTML = `
                <strong>❌ Błąd Wykonania</strong>
                <div style="margin-top: 10px; padding: 10px; background: white; border-radius: 5px;">
                    <pre style="white-space: pre-wrap; font-family: monospace; font-size: 13px;">${escapeHtml(data.error)}</pre>
                </div>
            `;
            const stepsOutput = document.getElementById('steps-output');
            if (stepsOutput) {
                stepsOutput.appendChild(errorDiv);
            }

            alert('Błąd wykonania: ' + data.error);
            break;

        case 'error':
            addLog(`Error: ${data.error}`, 'error');
            break;

        case 'history_cleared':
            document.getElementById('chat-messages').innerHTML = '';
            addLog('Chat history cleared', 'info');
            break;
    }
}

// Update connection status
function updateStatus(status) {
    const statusEl = document.getElementById('status');
    statusEl.textContent = status === 'connected' ? '● Połączono' : '● Rozłączono';
    statusEl.className = 'status ' + status;
}

// Add log entry
function addLog(message, type = 'info') {
    const logEl = document.getElementById('activity-log');
    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;
    const timestamp = new Date().toLocaleTimeString();
    entry.textContent = `[${timestamp}] ${message}`;
    logEl.appendChild(entry);
    logEl.scrollTop = logEl.scrollHeight;
}

// Clear logs
function clearLogs() {
    document.getElementById('activity-log').innerHTML = '';
}

// Tab switching
function switchTab(tabName) {
    // Update tab buttons
    document.querySelectorAll('.tab').forEach(tab => {
        tab.classList.remove('active');
    });
    event.target.classList.add('active');

    // Update tab content
    document.querySelectorAll('.tab-content').forEach(content => {
        content.classList.remove('active');
    });
    document.getElementById(`${tabName}-tab`).classList.add('active');

    // Load data for specific tabs
    if (tabName === 'history') {
        loadExecutionsHistory();
    } else if (tabName === 'agents') {
        loadAgents();
    } else if (tabName === 'config') {
        loadConfig();
    }
}

// Chat functions
// Chat UI functions removed - using only Execute Task workflow

// Plan execution functions
async function createPlanOnly() {
    const task = document.getElementById('task-input').value.trim();
    if (!task) {
        alert('Please enter a task description');
        return;
    }

    try {
        const response = await fetch('/api/plan', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ task }),
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error);
        }

        const data = await response.json();
        currentPlan = data.plan;
        displayPlan(data.plan, false);
    } catch (error) {
        addLog(`Plan creation error: ${error.message}`, 'error');
        alert('Error: ' + error.message);
    }
}

async function executeTask() {
    const task = document.getElementById('task-input').value.trim();
    if (!task) {
        alert('Please enter a task description');
        return;
    }

    // Clear previous plan and results immediately
    stepResults = {};
    currentPlan = null;
    const planSection = document.getElementById('plan-section');
    const stepsOutput = document.getElementById('steps-output');
    const resultSection = document.getElementById('result-section');
    const finalResult = document.getElementById('final-result');

    if (planSection) planSection.style.display = 'none';
    if (stepsOutput) stepsOutput.innerHTML = '';
    if (resultSection) resultSection.style.display = 'none';
    if (finalResult) finalResult.textContent = '';

    // Get file IDs to send
    const fileIds = uploadedFiles.map(f => f.filename);

    // Show abort button
    document.getElementById('abort-btn').style.display = 'inline-block';

    try {
        const response = await fetch('/api/execute', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                task,
                fileIds: fileIds.length > 0 ? fileIds : undefined
            }),
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error);
        }

        const data = await response.json();
        if (data.aborted) {
            addLog('Execution was aborted', 'warning');
        }

        // Clear uploaded files after execution
        clearUploadedFiles();
    } catch (error) {
        hideExecutionSpinner();
        document.getElementById('execute-btn').disabled = false;
        document.getElementById('abort-btn').style.display = 'none';
        addLog(`Execution error: ${error.message}`, 'error');
        alert('Error: ' + error.message);
    }
    // Note: abort button is hidden via WebSocket events (execution_complete, execution_error, execution_aborted)
}

function displayPlan(plan, showExecuting = true) {
    const viewCard = document.getElementById('plan-view-card');
    const viewEl = document.getElementById('plan-view');

    viewCard.style.display = 'block';

    let html = `
        <div style="margin-bottom: 20px;">
            <h3 style="color: #667eea;">Goal</h3>
            <p>${plan.goal}</p>
            <p style="margin-top: 10px;"><strong>Complexity:</strong>
                <span style="color: ${plan.estimatedComplexity === 'high' ? '#dc3545' : plan.estimatedComplexity === 'medium' ? '#ffc107' : '#28a745'}">
                    ${plan.estimatedComplexity.toUpperCase()}
                </span>
            </p>
        </div>
        <h3 style="color: #667eea; margin-bottom: 15px;">Steps</h3>
    `;

    plan.steps.forEach(step => {
        // Format model name if present - show full model ID
        let modelBadge = '';
        if (step.model) {
            console.log('[DEBUG] Step', step.step, 'has model:', step.model);
            modelBadge = `<span class="agent-badge" style="background: #f59e0b; margin-left: 8px; font-size: 10px;" title="${step.model}">${step.model}</span>`;
        } else {
            console.log('[DEBUG] Step', step.step, 'NO MODEL FIELD');
        }

        html += `
            <div class="step" id="step-${step.step}">
                <div class="step-header">
                    <span class="step-number">Step ${step.step}</span>
                    <span class="agent-badge">${step.agent.toUpperCase()}</span>${modelBadge}
                </div>
                <p style="font-weight: 600; margin-bottom: 8px;">${step.description}</p>
                <p style="color: #666; font-size: 14px;"><em>Reasoning:</em> ${step.reasoning}</p>
                <div class="step-result" id="result-${step.step}" style="display: none;"></div>
            </div>
        `;
    });

    viewEl.innerHTML = html;
    viewCard.scrollIntoView({ behavior: 'smooth' });
}

function updateStepStatus(stepNumber, status, result = null) {
    const stepEl = document.getElementById(`step-${stepNumber}`);
    if (!stepEl) return;

    stepEl.className = `step ${status}`;

    if (result) {
        const resultEl = document.getElementById(`result-${stepNumber}`);
        if (resultEl) {
            resultEl.style.display = 'block';
            resultEl.textContent = result;
        }
    }
}

// Agent management
async function loadAgents() {
    try {
        const response = await fetch('/api/agents');
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error);
        }

        const data = await response.json();
        displayAgents(data.agents);
    } catch (error) {
        addLog(`Error loading agents: ${error.message}`, 'error');
    }
}

function displayAgents(agents) {
    const gridEl = document.getElementById('agents-grid');

    gridEl.innerHTML = agents.map(agent => `
        <div class="agent-card">
            <h3>${agent.name}</h3>
            ${agent.model ? `<p style="color: #999; font-size: 13px; margin-bottom: 8px;"><strong>Model:</strong> <code>${agent.model}</code></p>` : ''}
            <p style="color: #666; margin-bottom: 10px;">${agent.description}</p>
            <div class="capabilities">
                <strong>Capabilities:</strong>
                <div style="margin-top: 8px;">
                    ${agent.capabilities.map(cap =>
                        `<span class="capability-tag">${cap.replace(/_/g, ' ')}</span>`
                    ).join('')}
                </div>
            </div>
            ${agent.tools ? `
                <div style="margin-top: 15px;">
                    <strong>Available Tools:</strong>
                    <div class="tool-list">
                        ${agent.tools.map(tool =>
                            `<span class="tool-tag">${tool}</span>`
                        ).join('')}
                    </div>
                </div>
            ` : ''}
        </div>
    `).join('');
}

// Load Claude models from API
async function loadClaudeModels() {
    try {
        const response = await fetch('/api/models/claude');
        const data = await response.json();

        if (!data.models || !data.models.all) {
            addLog('Using default Claude models', 'warning');
            return;
        }

        const modelSelect = document.getElementById('claude-model');
        const currentValue = modelSelect.value;

        // Build options HTML
        let optionsHTML = '';

        // Add latest models first
        if (data.models.latest.sonnet) {
            optionsHTML += `<option value="${data.models.latest.sonnet}">Latest Sonnet (${data.models.latest.sonnet})</option>`;
        }
        if (data.models.latest.opus) {
            optionsHTML += `<option value="${data.models.latest.opus}">Latest Opus (${data.models.latest.opus})</option>`;
        }
        if (data.models.latest.haiku) {
            optionsHTML += `<option value="${data.models.latest.haiku}">Latest Haiku (${data.models.latest.haiku})</option>`;
        }

        // Add separator
        if (data.models.all.sonnet.length > 1 || data.models.all.opus.length > 1 || data.models.all.haiku.length > 1) {
            optionsHTML += '<option disabled>──────────</option>';
        }

        // Add all Sonnet models
        if (data.models.all.sonnet.length > 0) {
            optionsHTML += '<option disabled>Sonnet Models:</option>';
            data.models.all.sonnet.forEach(model => {
                optionsHTML += `<option value="${model.id}">  ${model.name}</option>`;
            });
        }

        // Add all Opus models
        if (data.models.all.opus.length > 0) {
            optionsHTML += '<option disabled>Opus Models:</option>';
            data.models.all.opus.forEach(model => {
                optionsHTML += `<option value="${model.id}">  ${model.name}</option>`;
            });
        }

        // Add all Haiku models
        if (data.models.all.haiku.length > 0) {
            optionsHTML += '<option disabled>Haiku Models:</option>';
            data.models.all.haiku.forEach(model => {
                optionsHTML += `<option value="${model.id}">  ${model.name}</option>`;
            });
        }

        modelSelect.innerHTML = optionsHTML;

        // Restore previous value if it exists
        if (currentValue && [...modelSelect.options].some(opt => opt.value === currentValue)) {
            modelSelect.value = currentValue;
        }

        addLog('Loaded latest Claude models from API', 'success');
    } catch (error) {
        addLog(`Error loading Claude models: ${error.message}`, 'error');
    }
}

// Load Gemini models from API
async function loadGeminiModels() {
    try {
        const response = await fetch('/api/models/gemini');
        const data = await response.json();

        if (!data.models || data.models.length === 0) {
            addLog('Using default Gemini models', 'warning');
            // Fallback to hardcoded models
            const modelSelect = document.getElementById('gemini-model');
            modelSelect.innerHTML = `
                <option value="gemini-2.0-flash-exp">Gemini 2.0 Flash (Experimental)</option>
                <option value="gemini-1.5-pro">Gemini 1.5 Pro</option>
                <option value="gemini-1.5-flash">Gemini 1.5 Flash</option>
            `;
            return;
        }

        const modelSelect = document.getElementById('gemini-model');
        const currentValue = modelSelect.value;

        // Build options HTML from API models
        let optionsHTML = '';

        data.models.forEach(model => {
            const displayName = model.name || model.id;
            optionsHTML += `<option value="${model.id}" title="${model.description || ''}">${displayName}</option>`;
        });

        modelSelect.innerHTML = optionsHTML;

        // Restore previous value if it exists
        if (currentValue && [...modelSelect.options].some(opt => opt.value === currentValue)) {
            modelSelect.value = currentValue;
        }

        addLog('Loaded latest Gemini models from API', 'success');
    } catch (error) {
        addLog(`Error loading Gemini models: ${error.message}`, 'error');
        // Fallback to hardcoded models on error
        const modelSelect = document.getElementById('gemini-model');
        modelSelect.innerHTML = `
            <option value="gemini-2.0-flash-exp">Gemini 2.0 Flash (Experimental)</option>
            <option value="gemini-1.5-pro">Gemini 1.5 Pro</option>
            <option value="gemini-1.5-flash">Gemini 1.5 Flash</option>
        `;
    }
}

// Store Ollama models for description display
let ollamaModelsData = [];

async function loadOllamaModels() {
    try {
        const response = await fetch('/api/models/ollama');
        const data = await response.json();

        ollamaModelsData = data.models || [];

        // Display all models as cards (info only)
        const modelsListEl = document.getElementById('ollama-models-list');
        if (modelsListEl) {
            modelsListEl.innerHTML = data.models.map(model => `
                <div class="agent-card" style="margin-bottom: 15px;">
                    <h3>${model.name || model.id} ${model.recommended ? '⭐' : ''}</h3>
                    <p style="color: #666; margin-bottom: 10px; font-size: 14px;"><strong>ID:</strong> <code>${model.id}</code></p>
                    <p style="color: #666; margin-bottom: 10px;">${model.description || 'No description available'}</p>
                    ${model.size ? `<p style="color: #999; font-size: 13px; margin-bottom: 10px;">Size: ${model.size}</p>` : ''}
                    ${model.capabilities && model.capabilities.length > 0 ? `
                        <div class="capabilities">
                            <strong>Capabilities:</strong>
                            <div style="margin-top: 8px;">
                                ${model.capabilities.map(cap =>
                                    `<span class="capability-tag">${cap.replace(/_/g, ' ')}</span>`
                                ).join('')}
                            </div>
                        </div>
                    ` : ''}
                </div>
            `).join('');
        }

        // Populate dropdown
        const modelSelect = document.getElementById('ollama-model');
        if (modelSelect) {
            const currentValue = modelSelect.value;
            let optionsHTML = '';

            data.models.forEach(model => {
                const displayName = model.name || model.id;
                const recommended = model.recommended ? ' ⭐' : '';
                optionsHTML += `<option value="${model.id}">${displayName}${recommended}</option>`;
            });

            modelSelect.innerHTML = optionsHTML;

            // Restore previous selection if it exists
            if (currentValue && [...modelSelect.options].some(opt => opt.value === currentValue)) {
                modelSelect.value = currentValue;
            }
        }

        addLog('Loaded Ollama models from ollama-models.json', 'success');
    } catch (error) {
        addLog(`Error loading Ollama models: ${error.message}`, 'error');

        // Fallback display
        const modelsListEl = document.getElementById('ollama-models-list');
        if (modelsListEl) {
            modelsListEl.innerHTML = '<p style="color: #dc3545;">Error loading models. Check ollama-models.json</p>';
        }
    }
}

// Configuration management
async function loadConfig() {
    try {
        const response = await fetch('/api/config');
        const config = await response.json();

        // Load models dynamically from both APIs and MCP servers
        await Promise.all([
            loadClaudeModels(),
            loadGeminiModels(),
            loadOllamaModels(),
            loadMCPServers()
        ]);

        // Set current values from backend config file
        document.getElementById('claude-model').value = config.claudeConfig.model;
        document.getElementById('claude-temp').value = config.claudeConfig.temperature;
        document.getElementById('claude-tokens').value = config.claudeConfig.maxTokens;
        document.getElementById('claude-prompt').value = config.claudeConfig.customPrompt || '';

        document.getElementById('gemini-model').value = config.geminiConfig.model;
        document.getElementById('gemini-temp').value = config.geminiConfig.temperature;
        document.getElementById('gemini-tokens').value = config.geminiConfig.maxTokens;
        document.getElementById('gemini-prompt').value = config.geminiConfig.customPrompt || '';

        // Ollama config
        document.getElementById('ollama-model').value = config.ollamaConfig.model || 'qwen3:8b';
        document.getElementById('ollama-temp').value = config.ollamaConfig.temperature;
        document.getElementById('ollama-tokens').value = config.ollamaConfig.maxTokens;
        document.getElementById('ollama-prompt').value = config.ollamaConfig.customPrompt || '';

        // MLX config
        if (config.mlxConfig) {
            document.getElementById('mlx-model').value = config.mlxConfig.model || 'mlx-community/Llama-3.2-3B-Instruct-4bit';
            document.getElementById('mlx-temp').value = config.mlxConfig.temperature;
            document.getElementById('mlx-tokens').value = config.mlxConfig.maxTokens;
            document.getElementById('mlx-prompt').value = config.mlxConfig.customPrompt || '';
        }
        if (config.mlxBaseUrl) {
            document.getElementById('mlx-base-url').value = config.mlxBaseUrl;
            // Update start command with correct port and model
            updateMLXStartCommand();
        }

        addLog('Loaded model configuration from backend', 'success');
    } catch (error) {
        addLog(`Error loading config: ${error.message}`, 'error');
    }
}

async function loadMCPServers() {
    try {
        const response = await fetch('/api/mcp-servers');
        const data = await response.json();

        const mcpList = document.getElementById('mcp-servers-list');
        if (data.servers && data.servers.length > 0) {
            mcpList.innerHTML = data.servers.map(server => `
                <div class="step-item completed" style="margin-bottom: 10px;">
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                        <div>
                            <strong>🔌 ${server.name}</strong>
                            <div style="margin-top: 5px; font-size: 13px; color: #666;">
                                ${server.command}
                            </div>
                        </div>
                        <div>
                            <span class="capability-tag">${server.toolCount} narzędzi</span>
                        </div>
                    </div>
                </div>
            `).join('');
        } else {
            mcpList.innerHTML = '<div style="text-align: center; padding: 20px; color: #999;">Brak załadowanych serwerów MCP</div>';
        }
    } catch (error) {
        console.error('Error loading MCP servers:', error);
        document.getElementById('mcp-servers-list').innerHTML = '<div style="text-align: center; padding: 20px; color: #dc3545;">Błąd ładowania serwerów MCP</div>';
    }
}

async function saveConfig() {
    // Get custom prompts and only include if not empty
    const claudePrompt = document.getElementById('claude-prompt').value.trim();
    const geminiPrompt = document.getElementById('gemini-prompt').value.trim();
    const ollamaPrompt = document.getElementById('ollama-prompt').value.trim();
    const mlxPrompt = document.getElementById('mlx-prompt').value.trim();

    const config = {
        claudeConfig: {
            model: document.getElementById('claude-model').value,
            temperature: parseFloat(document.getElementById('claude-temp').value),
            maxTokens: parseInt(document.getElementById('claude-tokens').value),
            customPrompt: claudePrompt || undefined,
        },
        geminiConfig: {
            model: document.getElementById('gemini-model').value,
            temperature: parseFloat(document.getElementById('gemini-temp').value),
            maxTokens: parseInt(document.getElementById('gemini-tokens').value),
            customPrompt: geminiPrompt || undefined,
        },
        ollamaConfig: {
            model: document.getElementById('ollama-model').value,
            temperature: parseFloat(document.getElementById('ollama-temp').value),
            maxTokens: parseInt(document.getElementById('ollama-tokens').value),
            customPrompt: ollamaPrompt || undefined,
        },
        mlxConfig: {
            model: document.getElementById('mlx-model').value,
            temperature: parseFloat(document.getElementById('mlx-temp').value),
            maxTokens: parseInt(document.getElementById('mlx-tokens').value),
            customPrompt: mlxPrompt || undefined,
        },
        mlxBaseUrl: document.getElementById('mlx-base-url').value,
    };

    try {
        const response = await fetch('/api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(config),
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error);
        }

        addLog('Model configuration saved to backend file', 'success');
        alert('Model configuration saved successfully!\n\nSettings (including custom prompts) saved to magentic-config.json');
    } catch (error) {
        addLog(`Error saving config: ${error.message}`, 'error');
        alert('Error: ' + error.message);
    }
}

// Note: Export/Import removed - configure API keys and MCP in .env file

// Chat history functions removed - using only Execute Task workflow

// Abort execution
async function abortExecution() {
    try {
        const response = await fetch('/api/execute/abort', {
            method: 'POST',
        });

        if (response.ok) {
            addLog('Execution aborted', 'warning');
            document.getElementById('abort-btn').style.display = 'none';
        }
    } catch (error) {
        addLog(`Error aborting execution: ${error.message}`, 'error');
    }
}

// File upload handling
async function handleFileUpload(event) {
    const files = event.target.files;
    if (!files || files.length === 0) return;

    const formData = new FormData();
    for (let i = 0; i < files.length; i++) {
        formData.append('files', files[i]);
    }

    try {
        addLog(`Uploading ${files.length} file(s)...`, 'info');

        const response = await fetch('/api/upload', {
            method: 'POST',
            body: formData,
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error);
        }

        const data = await response.json();
        uploadedFiles.push(...data.files);

        displayUploadedFiles();
        addLog(`Uploaded ${data.files.length} file(s) successfully`, 'success');

        // Clear file input
        event.target.value = '';
    } catch (error) {
        addLog(`Error uploading files: ${error.message}`, 'error');
        alert('Error uploading files: ' + error.message);
    }
}

function displayUploadedFiles() {
    // Update both chat and task displays
    const displays = [
        { container: document.getElementById('uploaded-files-display'), list: document.getElementById('files-list') },
        { container: document.getElementById('uploaded-files-display-task'), list: document.getElementById('files-list-task') }
    ];

    displays.forEach(({ container, list }) => {
        if (!container || !list) return;

        if (uploadedFiles.length === 0) {
            container.style.display = 'none';
            return;
        }

        container.style.display = 'block';
        list.innerHTML = uploadedFiles.map((file, index) => `
            <div style="display: flex; justify-content: space-between; align-items: center; padding: 5px; background: white; margin-top: 5px; border-radius: 3px;">
                <span style="font-size: 13px;">📄 ${file.originalName} (${(file.size / 1024).toFixed(2)}KB)</span>
                <button onclick="removeFile(${index})" style="background: #dc3545; color: white; border: none; padding: 3px 8px; border-radius: 3px; cursor: pointer; font-size: 11px;">✕</button>
            </div>
        `).join('');
    });
}

function removeFile(index) {
    uploadedFiles.splice(index, 1);
    displayUploadedFiles();
    addLog('File removed', 'info');
}

function clearUploadedFiles() {
    uploadedFiles = [];
    displayUploadedFiles();
}

// Real-time execution output functions
function showExecutionOutput() {
    document.getElementById('execution-output').style.display = 'block';
    document.getElementById('plan-section').style.display = 'block';
    document.getElementById('result-section').style.display = 'none';
}

function showExecutionSpinner() {
    document.getElementById('execute-spinner').style.display = 'inline-block';
    document.getElementById('main-spinner').style.display = 'inline-block';
}

function hideExecutionSpinner() {
    document.getElementById('execute-spinner').style.display = 'none';
    document.getElementById('main-spinner').style.display = 'none';
}

function displayPlanRealtime(plan) {
    const planSteps = document.getElementById('plan-steps');
    planSteps.innerHTML = plan.steps.map(step => {
        // Format model badge if present
        const modelBadge = step.model ? `<span class="capability-tag" style="background: #f59e0b; color: white; margin-left: 5px;">${step.model}</span>` : '';

        return `
        <div class="step-item" id="plan-step-${step.step}">
            <div class="step-header-collapsible" onclick="toggleStepDetails(${step.step})" style="cursor: pointer;">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <div>
                        <strong>⏳ Krok ${step.step}:</strong> ${step.description}
                        <span id="collapse-indicator-${step.step}" style="margin-left: 10px; color: #666; font-size: 12px;">▼</span>
                    </div>
                    <div>
                        <span class="capability-tag">${step.agent}</span>
                        ${modelBadge}
                    </div>
                </div>
            </div>
            <div class="step-details" id="step-details-${step.step}" style="display: none; margin-top: 12px;">
                <div style="padding: 10px; background: #f8f9fa; border-radius: 6px;">
                    <strong style="color: #667eea;">Uzasadnienie:</strong>
                    <div style="margin-top: 6px; font-size: 13px; color: #666;">${step.reasoning}</div>
                </div>
            </div>
        </div>
        `;
    }).join('');
}

function updateStepStatusRealtime(stepNumber, status, stepData, result) {
    const stepEl = document.getElementById(`plan-step-${stepNumber}`);
    if (!stepEl) return;

    const detailsDiv = document.getElementById(`step-details-${stepNumber}`);

    // Format model badge if present
    const modelBadge = stepData.model ? `<span class="capability-tag" style="background: #f59e0b; color: white; margin-left: 5px;">${stepData.model}</span>` : '';

    if (status === 'executing') {
        stepEl.classList.add('active');

        // Update header to show executing status
        const headerDiv = stepEl.querySelector('.step-header-collapsible > div');
        if (headerDiv) {
            headerDiv.innerHTML = `
                <div style="display: flex; align-items: center; gap: 10px;">
                    <strong>🔄 Krok ${stepNumber}:</strong> ${stepData.description}
                    <span id="collapse-indicator-${stepNumber}" style="color: #666; font-size: 12px;">▼</span>
                    <div class="spinner" style="width: 16px; height: 16px;"></div>
                </div>
                <div>
                    <span class="capability-tag">${stepData.agent}</span>
                    ${modelBadge}
                </div>
            `;
        }

        // Show query in details
        if (detailsDiv) {
            detailsDiv.innerHTML = `
                <div style="padding: 10px; background: #fff8e1; border-radius: 6px; margin-bottom: 8px; border-left: 3px solid #ffc107;">
                    <strong style="color: #f57c00;">📤 Zapytanie do agenta:</strong>
                    <div style="margin-top: 6px; font-family: monospace; font-size: 13px;">${escapeHtml(stepData.description)}</div>
                </div>
                <div style="padding: 10px; background: #f8f9fa; border-radius: 6px; display: flex; align-items: center; gap: 8px;">
                    <div class="spinner" style="width: 16px; height: 16px;"></div>
                    <span style="color: #666;">Oczekiwanie na odpowiedź...</span>
                </div>
            `;
            detailsDiv.style.display = 'block'; // Show details during execution
        }

    } else if (status === 'completed') {
        stepEl.classList.remove('active');
        stepEl.classList.add('completed');

        // Update header to show completed status
        const headerDiv = stepEl.querySelector('.step-header-collapsible > div');
        if (headerDiv) {
            headerDiv.innerHTML = `
                <div>
                    <strong>✅ Krok ${stepNumber}:</strong> ${stepData.description}
                    <span id="collapse-indicator-${stepNumber}" style="margin-left: 10px; color: #666; font-size: 12px;">▼</span>
                </div>
                <div>
                    <span class="capability-tag">${stepData.agent}</span>
                    ${modelBadge}
                </div>
            `;
        }

        // Update details with query and response
        if (detailsDiv) {
            let toolCallsHtml = '';
            if (stepData.toolCalls && stepData.toolCalls.length > 0) {
                toolCallsHtml = `
                    <div style="padding: 10px; background: #fff3cd; border-radius: 6px; margin-bottom: 8px; border-left: 3px solid #ffc107;">
                        <strong style="color: #856404;">🛠️ Wywołania narzędzi (${stepData.toolCalls.length}):</strong>
                        ${stepData.toolCalls.map((tc, idx) => `
                            <div style="margin-top: 8px; padding: 8px; background: white; border-radius: 4px; border: 1px solid #ffc107;">
                                <div style="font-weight: bold; color: #856404;">${idx + 1}. ${tc.name}</div>
                                <div style="font-size: 12px; color: #666; margin-top: 4px;">
                                    <strong>Input:</strong>
                                    <pre style="margin: 4px 0; padding: 6px; background: #f8f9fa; border-radius: 3px; overflow-x: auto; font-size: 11px;">${JSON.stringify(tc.input, null, 2)}</pre>
                                </div>
                                ${tc.result ? `
                                <div style="font-size: 12px; color: #666; margin-top: 4px;">
                                    <strong>Result:</strong>
                                    <pre style="margin: 4px 0; padding: 6px; background: #e7f5ff; border-radius: 3px; overflow-x: auto; font-size: 11px;">${JSON.stringify(tc.result, null, 2)}</pre>
                                </div>
                                ` : ''}
                            </div>
                        `).join('')}
                    </div>
                `;
            }

            detailsDiv.innerHTML = `
                <div style="padding: 10px; background: #f8f9fa; border-radius: 6px; margin-bottom: 8px;">
                    <strong style="color: #667eea;">📤 Zapytanie do agenta:</strong>
                    <div style="margin-top: 6px; font-family: monospace; font-size: 13px;">${escapeHtml(stepData.description)}</div>
                </div>
                ${toolCallsHtml}
                <div style="padding: 12px; background: white; border-radius: 6px; border-left: 3px solid #28a745;">
                    <strong style="color: #28a745;">📥 Odpowiedź agenta:</strong>
                    <div class="output-text" style="margin-top: 8px; white-space: pre-wrap;">${escapeHtml(result)}</div>
                </div>
            `;

            // Auto-collapse after 3 seconds
            setTimeout(() => {
                if (detailsDiv.style.display !== 'none') {
                    detailsDiv.style.display = 'none';
                    const indicator = document.getElementById(`collapse-indicator-${stepNumber}`);
                    if (indicator) indicator.textContent = '▼';
                }
            }, 3000);
        }

        // Scroll to view
        stepEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
}

// Toggle step details visibility
function toggleStepDetails(stepNumber) {
    const details = document.getElementById(`step-details-${stepNumber}`);
    const indicator = document.getElementById(`collapse-indicator-${stepNumber}`);

    if (details) {
        if (details.style.display === 'none') {
            details.style.display = 'block';
            if (indicator) indicator.textContent = '▲';
        } else {
            details.style.display = 'none';
            if (indicator) indicator.textContent = '▼';
        }
    }
}

function displayFinalResult(result) {
    document.getElementById('result-section').style.display = 'block';
    document.getElementById('final-result').textContent = result;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Load executions history
async function loadExecutionsHistory() {
    try {
        const response = await fetch('/api/executions');
        const data = await response.json();

        const listEl = document.getElementById('executions-list');
        if (data.executions && data.executions.length > 0) {
            listEl.innerHTML = data.executions.map(exec => `
                <div class="step-item ${exec.aborted ? 'error' : 'completed'}" style="cursor: pointer;" onclick="viewExecution('${exec.id}')">
                    <div style="display: flex; justify-content: space-between; align-items: start;">
                        <div style="flex: 1;">
                            <strong>${exec.task}</strong>
                            <div style="margin-top: 8px; font-size: 13px; color: #666;">
                                ${new Date(exec.createdAt).toLocaleString('pl-PL')}
                                • ${exec.stepCount} kroków
                                ${exec.aborted ? '• <span style="color: #dc3545;">Przerwane</span>' : ''}
                            </div>
                        </div>
                        <button class="btn btn-secondary" onclick="event.stopPropagation(); viewExecution('${exec.id}')" style="margin-left: 10px;">
                            Zobacz szczegóły
                        </button>
                    </div>
                </div>
            `).join('');
        } else {
            listEl.innerHTML = '<div style="text-align: center; padding: 40px; color: #999;">Brak wykonań w historii</div>';
        }
    } catch (error) {
        console.error('Error loading executions:', error);
        document.getElementById('executions-list').innerHTML = '<div style="text-align: center; padding: 40px; color: #dc3545;">Błąd ładowania historii</div>';
    }
}

async function viewExecution(executionId) {
    try {
        const response = await fetch(`/api/executions/${executionId}`);
        const data = await response.json();

        if (data.execution) {
            // Show execution details in a modal or detailed view
            alert(`Execution details:\n${JSON.stringify(data.execution, null, 2)}`);
            // TODO: Implement proper modal/detail view
        }
    } catch (error) {
        console.error('Error loading execution:', error);
        alert('Błąd ładowania szczegółów wykonania');
    }
}

// Export result in different formats
let currentExecutionData = null; // Store current execution data for export

function exportResult(format) {
    const finalResult = document.getElementById('final-result').textContent;

    if (!finalResult) {
        alert('Brak wyniku do eksportu');
        return;
    }

    let content = '';
    let filename = '';
    let mimeType = '';
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);

    switch (format) {
        case 'txt':
            content = finalResult;
            filename = `wynik-${timestamp}.txt`;
            mimeType = 'text/plain';
            break;

        case 'json':
            const jsonData = {
                timestamp: new Date().toISOString(),
                result: finalResult,
                plan: currentPlan || null,
                execution: currentExecutionData || null
            };
            content = JSON.stringify(jsonData, null, 2);
            filename = `wynik-${timestamp}.json`;
            mimeType = 'application/json';
            break;

        case 'md':
            content = `# Wynik Wykonania Zadania\n\n`;
            content += `**Data:** ${new Date().toLocaleString('pl-PL')}\n\n`;
            content += `## Plan Wykonania\n\n`;
            if (currentPlan && currentPlan.steps) {
                currentPlan.steps.forEach(step => {
                    content += `### Krok ${step.step}: ${step.description}\n`;
                    content += `- **Agent:** ${step.agent}\n`;
                    if (step.model) {
                        content += `- **Model:** ${step.model}\n`;
                    }
                    content += `- **Uzasadnienie:** ${step.reasoning}\n\n`;
                });
            }
            content += `## Wynik Końcowy\n\n`;
            content += finalResult;
            filename = `wynik-${timestamp}.md`;
            mimeType = 'text/markdown';
            break;

        default:
            alert('Nieznany format eksportu');
            return;
    }

    // Create download link
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    addLog(`Wyeksportowano wynik jako ${filename}`, 'success');
}

// Ollama Prompts Management
let ollamaPrompts = {};
let currentPromptKey = null;

// Load available Ollama prompts
async function loadOllamaPrompts() {
    try {
        const response = await fetch('/api/ollama/prompts');
        ollamaPrompts = await response.json();

        // Populate selector
        const selector = document.getElementById('ollama-prompt-selector');
        selector.innerHTML = '';

        Object.keys(ollamaPrompts).forEach(key => {
            const prompt = ollamaPrompts[key];
            const option = document.createElement('option');
            option.value = key;
            option.textContent = `${prompt.name} - ${prompt.description}`;
            selector.appendChild(option);
        });

        // Select default by default
        selector.value = 'default';
        currentPromptKey = 'default';

        addLog('Loaded Ollama prompt templates', 'success');
    } catch (error) {
        addLog(`Error loading Ollama prompts: ${error.message}`, 'error');
    }
}

// Load selected prompt into textarea
function loadSelectedPrompt() {
    const selector = document.getElementById('ollama-prompt-selector');
    const key = selector.value;

    if (ollamaPrompts[key]) {
        document.getElementById('ollama-prompt').value = ollamaPrompts[key].prompt;
        currentPromptKey = key;
        addLog(`Loaded prompt: ${ollamaPrompts[key].name}`, 'success');
    }
}

// Save current prompt to magentic-config.json
async function savePromptToFile() {
    const selector = document.getElementById('ollama-prompt-selector');
    const key = selector.value;
    const promptText = document.getElementById('ollama-prompt').value;

    if (!key) {
        alert('Please select a prompt template first');
        return;
    }

    // Update the prompt in memory
    if (ollamaPrompts[key]) {
        ollamaPrompts[key].prompt = promptText;
    }

    try {
        const response = await fetch('/api/ollama/prompts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(ollamaPrompts)
        });

        const result = await response.json();
        addLog(`Saved prompt "${ollamaPrompts[key].name}" to magentic-config.json`, 'success');
        alert(`Prompt saved to magentic-config.json!\n\nTemplate: ${ollamaPrompts[key].name}`);
    } catch (error) {
        addLog(`Error saving prompt: ${error.message}`, 'error');
        alert(`Error saving prompt: ${error.message}`);
    }
}

// Set active prompt (will be used for next execution)
async function setActivePrompt() {
    const selector = document.getElementById('ollama-prompt-selector');
    const key = selector.value;

    if (!key || !ollamaPrompts[key]) {
        alert('Please select a prompt template first');
        return;
    }

    try {
        const response = await fetch('/api/ollama/set-prompt', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ promptKey: key })
        });

        const result = await response.json();
        addLog(`Active prompt set to: ${result.promptName}`, 'success');
        alert(`Active prompt set successfully!\n\nPrompt: ${result.promptName}\n\nThis prompt will be used for Ollama/Bielik executions.`);
    } catch (error) {
        addLog(`Error setting active prompt: ${error.message}`, 'error');
        alert(`Error: ${error.message}`);
    }
}

// Manage prompts (show info)
function managePrompts() {
    const info = `Zarządzanie Promptami Ollama

Masz 3 opcje:

1. 📋 Load Prompt - Wczytaj wybrany szablon do edycji
2. 💾 Save to magentic-config.json - Zapisz edytowany prompt z powrotem do pliku
3. ✅ Set as Active Prompt - Ustaw wybrany prompt jako aktywny dla Bielika

Pliki:
• magentic-config.json - Twoje szablony promptów
• magentic-config.json.example - Przykładowe prompty

Szablony domyślne:
• default - Podstawowy prompt bez dodatkowych instrukcji
• custom - Pusty szablon do własnych promptów

Edytuj magentic-config.json aby dodać więcej szablonów!`;

    alert(info);
}

// Load executions history
async function loadExecutionsHistory() {
    try {
        const response = await fetch('/api/executions');
        const executions = await response.json();

        const container = document.getElementById('executions-list');

        if (executions.length === 0) {
            container.innerHTML = '<div style="text-align: center; padding: 20px; color: #999;"><p>Brak historii wykonań</p></div>';
            return;
        }

        container.innerHTML = '';

        executions.forEach(exec => {
            const item = document.createElement('div');
            item.className = 'execution-item';
            item.style.cssText = 'padding: 12px; margin-bottom: 10px; background: #f8f9fa; border-radius: 8px; cursor: pointer; border-left: 4px solid #667eea; transition: all 0.2s;';

            // Truncate task for display
            const taskPreview = exec.task.length > 50 ? exec.task.substring(0, 50) + '...' : exec.task;

            // Format date
            const date = new Date(exec.createdAt);
            const dateStr = date.toLocaleDateString('pl-PL', { day: '2-digit', month: '2-digit' }) + ' ' +
                           date.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });

            // Show steps info: executed / planned
            const stepsInfo = exec.plannedSteps > 0
                ? `Kroków: ${exec.stepCount}/${exec.plannedSteps}`
                : `Kroków: ${exec.stepCount}`;

            item.innerHTML = `
                <div style="font-size: 12px; color: #667eea; font-weight: 600; margin-bottom: 5px;">${dateStr}</div>
                <div style="font-size: 13px; margin-bottom: 5px;">${taskPreview}</div>
                <div style="font-size: 11px; color: #666;">${stepsInfo}</div>
            `;

            item.onmouseover = () => {
                item.style.background = '#e3f2fd';
                item.style.transform = 'translateX(5px)';
            };

            item.onmouseout = () => {
                item.style.background = '#f8f9fa';
                item.style.transform = 'translateX(0)';
            };

            item.onclick = () => viewExecutionDetails(exec.id);

            container.appendChild(item);
        });
    } catch (error) {
        console.error('Failed to load executions:', error);
        document.getElementById('executions-list').innerHTML =
            '<div style="text-align: center; padding: 20px; color: #dc3545;"><p>Błąd ładowania historii</p></div>';
    }
}

// View execution details
async function viewExecutionDetails(executionId) {
    try {
        const response = await fetch(`/api/executions/${executionId}`);
        const execution = await response.json();

        // Build detailed view
        let html = `
            <div style="max-width: 900px; margin: 0 auto;">
                <div style="background: white; padding: 25px; border-radius: 15px; box-shadow: 0 4px 10px rgba(0,0,0,0.1);">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
                        <h2 style="margin: 0; color: #667eea;">📄 Szczegóły Wykonania</h2>
                        <button class="btn btn-secondary" onclick="closeExecutionDetails()">← Powrót</button>
                    </div>

                    <div style="margin-bottom: 20px; padding: 15px; background: #f8f9fa; border-radius: 8px;">
                        <strong style="color: #667eea;">Zadanie:</strong>
                        <p style="margin: 10px 0 0 0;">${execution.messages.find(m => m.role === 'user')?.content || 'N/A'}</p>
                    </div>`;

        // Show manager's plan with all steps
        if (execution.plan) {
            html += `
                    <div style="margin-bottom: 20px; padding: 15px; background: #fff3cd; border-radius: 8px; border-left: 4px solid #ffc107;">
                        <strong style="color: #856404;">📋 Plan Managera:</strong>
                        <p style="margin: 10px 0 5px 0;"><strong>Cel:</strong> ${execution.plan.goal}</p>
                        <p style="margin: 5px 0;"><strong>Kroków:</strong> ${execution.plan.steps.length}</p>
                    </div>`;

            // Show all planned steps
            html += '<div style="margin-bottom: 20px;"><h3 style="color: #333; margin-bottom: 15px;">🔧 Kroki (Plan i Wykonanie):</h3>';

            execution.plan.steps.forEach((plannedStep, idx) => {
                // Find corresponding execution for this step
                const stepExecution = execution.stepExecutions?.find(se => se.stepNumber === plannedStep.step);

                let statusColor = '#e0e0e0'; // Default: not executed
                let statusText = 'Nie wykonano';
                let statusBg = '#6c757d';

                if (stepExecution) {
                    if (stepExecution.status === 'completed') {
                        statusColor = '#28a745';
                        statusText = 'Wykonano';
                        statusBg = '#28a745';
                    } else if (stepExecution.status === 'error') {
                        statusColor = '#dc3545';
                        statusText = 'Błąd';
                        statusBg = '#dc3545';
                    } else if (stepExecution.status === 'executing') {
                        statusColor = '#ffc107';
                        statusText = 'Wykonywanie';
                        statusBg = '#ffc107';
                    } else if (stepExecution.status === 'aborted') {
                        statusColor = '#dc3545';
                        statusText = 'Przerwano';
                        statusBg = '#dc3545';
                    }
                }

                html += `
                    <div style="margin-bottom: 15px; padding: 15px; background: #f8f9fa; border-radius: 8px; border-left: 4px solid ${statusColor};">
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                            <strong style="color: #667eea;">Krok ${plannedStep.step}: ${plannedStep.agent}</strong>
                            <span style="padding: 4px 10px; background: ${statusBg}; color: white; border-radius: 12px; font-size: 11px; font-weight: 600;">${statusText}</span>
                        </div>
                        <div style="font-size: 13px; margin-bottom: 8px;">${plannedStep.description}</div>`;

                if (plannedStep.model) {
                    html += `<div style="font-size: 12px; color: #666; margin-bottom: 8px;">Model: ${plannedStep.model}</div>`;
                }

                // If step was executed, show tool calls
                if (stepExecution && stepExecution.toolCalls && stepExecution.toolCalls.length > 0) {
                    html += `<div style="margin-top: 10px; padding: 10px; background: #fff3cd; border-radius: 5px; border-left: 3px solid #ffc107;">
                                <strong style="font-size: 12px; color: #856404;">🛠️ Wywołania narzędzi (${stepExecution.toolCalls.length}):</strong>`;

                    stepExecution.toolCalls.forEach((tool, idx) => {
                        const inputStr = JSON.stringify(tool.input, null, 2);
                        const resultStr = tool.result ? JSON.stringify(tool.result, null, 2) : null;

                        html += `
                            <div style="margin-top: 8px; padding: 8px; background: white; border-radius: 4px; border: 1px solid #ffc107;">
                                <div style="font-weight: bold; color: #856404;">${idx + 1}. ${tool.name}</div>
                                <div style="font-size: 11px; color: #666; margin-top: 4px;">
                                    <strong>Input:</strong>
                                    <pre style="margin: 4px 0; padding: 6px; background: #f8f9fa; border-radius: 3px; overflow-x: auto; font-size: 10px; max-height: 200px;">${escapeHtml(inputStr)}</pre>
                                </div>
                                ${resultStr ? `
                                <div style="font-size: 11px; color: #666; margin-top: 4px;">
                                    <strong>Result:</strong>
                                    <pre style="margin: 4px 0; padding: 6px; background: #e7f5ff; border-radius: 3px; overflow-x: auto; font-size: 10px; max-height: 200px;">${escapeHtml(resultStr)}</pre>
                                </div>
                                ` : ''}
                            </div>`;
                    });

                    html += '</div>';
                }

                // If step has error, show error message
                if (stepExecution && stepExecution.error) {
                    html += `<div style="margin-top: 10px; padding: 10px; background: #f8d7da; border-radius: 5px; border-left: 3px solid #dc3545;">
                                <strong style="font-size: 12px; color: #721c24;">❌ Błąd:</strong>
                                <div style="margin-top: 6px; font-size: 12px; color: #721c24; white-space: pre-wrap;">${escapeHtml(stepExecution.error)}</div>
                            </div>`;
                }

                html += '</div>';
            });

            html += '</div>';
        } else if (execution.stepExecutions && execution.stepExecutions.length > 0) {
            // Fallback: show only executed steps if no plan available
            html += '<div style="margin-bottom: 20px;"><h3 style="color: #333; margin-bottom: 15px;">🔧 Wykonane Kroki:</h3>';

            execution.stepExecutions.forEach((step, idx) => {
                const statusColor = step.status === 'completed' ? '#28a745' :
                                   step.status === 'error' ? '#dc3545' : '#ffc107';

                html += `
                    <div style="margin-bottom: 15px; padding: 15px; background: #f8f9fa; border-radius: 8px; border-left: 4px solid ${statusColor};">
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                            <strong style="color: #667eea;">Krok ${step.stepNumber}: ${step.agent}</strong>
                            <span style="padding: 4px 10px; background: ${statusColor}; color: white; border-radius: 12px; font-size: 11px; font-weight: 600;">${step.status}</span>
                        </div>
                        <div style="font-size: 13px; margin-bottom: 8px;">${step.description}</div>`;

                if (step.model) {
                    html += `<div style="font-size: 12px; color: #666; margin-bottom: 8px;">Model: ${step.model}</div>`;
                }

                if (step.toolCalls && step.toolCalls.length > 0) {
                    html += `<div style="margin-top: 10px; padding: 10px; background: #fff3cd; border-radius: 5px; border-left: 3px solid #ffc107;">
                                <strong style="font-size: 12px; color: #856404;">🛠️ Wywołania narzędzi (${step.toolCalls.length}):</strong>`;

                    step.toolCalls.forEach((tool, idx) => {
                        const inputStr = JSON.stringify(tool.input, null, 2);
                        const resultStr = tool.result ? JSON.stringify(tool.result, null, 2) : null;

                        html += `
                            <div style="margin-top: 8px; padding: 8px; background: white; border-radius: 4px; border: 1px solid #ffc107;">
                                <div style="font-weight: bold; color: #856404;">${idx + 1}. ${tool.name}</div>
                                <div style="font-size: 11px; color: #666; margin-top: 4px;">
                                    <strong>Input:</strong>
                                    <pre style="margin: 4px 0; padding: 6px; background: #f8f9fa; border-radius: 3px; overflow-x: auto; font-size: 10px; max-height: 200px;">${escapeHtml(inputStr)}</pre>
                                </div>
                                ${resultStr ? `
                                <div style="font-size: 11px; color: #666; margin-top: 4px;">
                                    <strong>Result:</strong>
                                    <pre style="margin: 4px 0; padding: 6px; background: #e7f5ff; border-radius: 3px; overflow-x: auto; font-size: 10px; max-height: 200px;">${escapeHtml(resultStr)}</pre>
                                </div>
                                ` : ''}
                            </div>`;
                    });

                    html += '</div>';
                }

                // If step has error, show error message
                if (step.error) {
                    html += `<div style="margin-top: 10px; padding: 10px; background: #f8d7da; border-radius: 5px; border-left: 3px solid #dc3545;">
                                <strong style="font-size: 12px; color: #721c24;">❌ Błąd:</strong>
                                <div style="margin-top: 6px; font-size: 12px; color: #721c24; white-space: pre-wrap;">${escapeHtml(step.error)}</div>
                            </div>`;
                }

                html += '</div>';
            });

            html += '</div>';
        }

        html += `
                </div>
            </div>`;

        // Show modal or replace content
        const mainContent = document.querySelector('#execute-tab > div > div:last-child');
        mainContent.innerHTML = html;

    } catch (error) {
        console.error('Failed to load execution details:', error);
        alert('Błąd ładowania szczegółów wykonania');
    }
}

// Close execution details
function closeExecutionDetails() {
    location.reload(); // Simple way to restore the original view
}

// Load manager prompt from config
async function loadManagerPrompt() {
    try {
        const response = await fetch('/api/manager/prompt');
        const data = await response.json();

        if (data.prompt) {
            document.getElementById('manager-prompt').value = data.prompt;
            addLog('Loaded manager prompt from config', 'success');
        } else {
            document.getElementById('manager-prompt').value = '';
            addLog('No manager prompt found in config', 'warning');
        }
    } catch (error) {
        console.error('Failed to load manager prompt:', error);
        addLog(`Error loading manager prompt: ${error.message}`, 'error');
    }
}

// Save manager prompt to config
async function saveManagerPrompt() {
    const promptText = document.getElementById('manager-prompt').value.trim();

    if (!promptText) {
        alert('Manager prompt cannot be empty');
        return;
    }

    try {
        const response = await fetch('/api/manager/prompt', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: promptText })
        });

        const result = await response.json();

        if (response.ok) {
            addLog('Manager prompt saved to magentic-config.json', 'success');
            alert('✅ Manager prompt saved successfully!\n\n⚠️ Restart the server for changes to take effect:\nnpm run ui');
        } else {
            addLog(`Error saving manager prompt: ${result.error}`, 'error');
            alert(`Error: ${result.error}`);
        }
    } catch (error) {
        console.error('Failed to save manager prompt:', error);
        addLog(`Error saving manager prompt: ${error.message}`, 'error');
        alert(`Error: ${error.message}`);
    }
}

// Update MLX start command with current config
function updateMLXStartCommand() {
    const model = document.getElementById('mlx-model')?.value || 'mlx-community/Llama-3.2-3B-Instruct-4bit';
    const baseUrl = document.getElementById('mlx-base-url')?.value || 'http://localhost:8080';

    // Extract port from URL
    let port = '8080';
    try {
        const url = new URL(baseUrl);
        port = url.port || '8080';
    } catch (e) {
        // Invalid URL, use default
    }

    const command = `mlx_lm.server --model ${model} --port ${port}`;
    const commandElement = document.getElementById('mlx-start-command');
    if (commandElement) {
        commandElement.textContent = command;
    }
}

// Initialize application
document.addEventListener('DOMContentLoaded', () => {
    // Initialize WebSocket
    initWebSocket();

    // Load initial data
    addLog('Application initialized', 'success');

    // Load executions history
    loadExecutionsHistory();

    // Load Ollama prompts and Manager prompt when config tab is opened
    const configTab = document.querySelector('[onclick*="config"]');
    if (configTab) {
        configTab.addEventListener('click', () => {
            setTimeout(loadOllamaPrompts, 100);
            setTimeout(loadManagerPrompt, 100);
        });
    }

    // Update MLX command when model or URL changes
    const mlxModelInput = document.getElementById('mlx-model');
    const mlxBaseUrlInput = document.getElementById('mlx-base-url');

    if (mlxModelInput) {
        mlxModelInput.addEventListener('input', updateMLXStartCommand);
    }
    if (mlxBaseUrlInput) {
        mlxBaseUrlInput.addEventListener('input', updateMLXStartCommand);
    }
});
