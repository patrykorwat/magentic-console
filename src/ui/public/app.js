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
            updateStepStatusRealtime(data.step.step, 'executing', data.step);
            addLog(`Wykonywanie kroku ${data.step.step} z ${data.step.agent}`, 'info');
            break;

        case 'step_complete':
            stepResults[data.step.step] = data.result;
            updateStepStatusRealtime(data.step.step, 'completed', data.step, data.result);
            addLog(`Krok ${data.step.step} zakończony`, 'success');
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
            break;

        case 'execution_aborted':
            hideExecutionSpinner();
            document.getElementById('execute-btn').disabled = false;
            document.getElementById('abort-btn').style.display = 'none';
            addLog('Wykonanie przerwane przez użytkownika', 'warning');
            alert('Wykonanie zostało przerwane');
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

    stepResults = {};

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

// Configuration management
async function loadConfig() {
    try {
        const response = await fetch('/api/config');
        const config = await response.json();

        // Load models dynamically from both APIs and MCP servers
        await Promise.all([
            loadClaudeModels(),
            loadGeminiModels(),
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

    const config = {
        claudeConfig: {
            model: document.getElementById('claude-model').value,
            temperature: parseFloat(document.getElementById('claude-temp').value),
            maxTokens: parseInt(document.getElementById('claude-tokens').value),
            customPrompt: claudePrompt || undefined, // Only save if not empty
        },
        geminiConfig: {
            model: document.getElementById('gemini-model').value,
            temperature: parseFloat(document.getElementById('gemini-temp').value),
            maxTokens: parseInt(document.getElementById('gemini-tokens').value),
            customPrompt: geminiPrompt || undefined, // Only save if not empty
        },
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
    planSteps.innerHTML = plan.steps.map(step => `
        <div class="step-item" id="plan-step-${step.step}">
            <div class="step-header-collapsible" onclick="toggleStepDetails(${step.step})" style="cursor: pointer;">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <div>
                        <strong>⏳ Krok ${step.step}:</strong> ${step.description}
                        <span id="collapse-indicator-${step.step}" style="margin-left: 10px; color: #666; font-size: 12px;">▼</span>
                    </div>
                    <div>
                        <span class="capability-tag">${step.agent}</span>
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
    `).join('');
}

function updateStepStatusRealtime(stepNumber, status, stepData, result) {
    const stepEl = document.getElementById(`plan-step-${stepNumber}`);
    if (!stepEl) return;

    const detailsDiv = document.getElementById(`step-details-${stepNumber}`);

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
                </div>
            `;
        }

        // Update details with query and response
        if (detailsDiv) {
            detailsDiv.innerHTML = `
                <div style="padding: 10px; background: #f8f9fa; border-radius: 6px; margin-bottom: 8px;">
                    <strong style="color: #667eea;">📤 Zapytanie do agenta:</strong>
                    <div style="margin-top: 6px; font-family: monospace; font-size: 13px;">${escapeHtml(stepData.description)}</div>
                </div>
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

// Initialize application
document.addEventListener('DOMContentLoaded', () => {
    // Initialize WebSocket
    initWebSocket();

    // Load initial data
    addLog('Application initialized', 'success');
});
