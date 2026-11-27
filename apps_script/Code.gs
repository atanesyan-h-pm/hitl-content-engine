/**
 * HUMAN-IN-THE-LOOP (HITL) B2B CONTENT PUBLISHING ENGINE (v2)
 * Google Sheets -> Apps Script (Code.gs) -> Cloud Run (main.py) -> Google Docs (Drive v3)
 *
 * Security & Reliability Guarantees:
 * - Zero hardcoded URLs, secrets, or private Drive IDs in source code.
 * -CLOUD_RUN_URL and WEBHOOK_SHARED_SECRET stored in PropertiesService (ScriptProperties).
 * - Agent A-D prompt Google Doc IDs and target output folders routed via Experiment_Config tab.
 * - Server-side prompt fetching on Cloud Run (Apps Script sends prompt_doc_id, never raw prompt text).
 * - Active tab guard + LockService.getDocumentLock() concurrency protection.
 * - Phase 1 split into 3 per-stage calls (research -> plan -> write) with Drive checkpointing
 *   so late-stage failures resume without re-billing completed stages.
 * - Non-destructive status/error columns (Cols H-L) and prior Doc URLs archived in cell Notes.
 * - Phase 2 enforces normalized 'approved' check + 0 unresolved Google Docs comments gate,
 *   supports both /document/d/ and ?id= URLs, and imports Markdown-to-HTML via Drive v3.
 */

const PROPERTY_KEYS = {
  CLOUD_RUN_URL: 'CLOUD_RUN_URL',
  WEBHOOK_SHARED_SECRET: 'WEBHOOK_SHARED_SECRET',
  TRACKER_SHEET_NAME: 'TRACKER_SHEET_NAME',
  CONFIG_SHEET_NAME: 'CONFIG_SHEET_NAME'
};

const DEFAULT_ALLOWED_TRACKER_TABS = ['arical backlog', 'article backlog', 'master content tracker'];
const DEFAULT_CONFIG_SHEET_NAME = 'Experiment_Config';

const HEADER_ALIASES = {
  topic: ['topic'],
  coreFocus: ['core focus', 'core_focus'],
  description: ['description', 'context'],
  v1DocUrl: ['output doc link', 'v1 doc link', 'draft doc link'],
  approvalStatus: ['human edits', 'humen edites', 'approval', 'approval status'],
  v2DocUrl: ['reviewed doc link', 'final doc link', 'v2 doc link'],
  humanReview: ['human review', 'himen review', 'cms status'],
  pipelineStatus: ['pipeline status'],
  experimentId: ['experiment id', 'experiment_id'],
  checkpointState: ['checkpoint state'],
  lastRunMetrics: ['last run metrics'],
  lastError: ['last error']
};

const STATUS_COLUMN_DEFAULTS = [
  { key: 'pipelineStatus', col: 8, title: 'Pipeline Status' },
  { key: 'experimentId', col: 9, title: 'Experiment ID' },
  { key: 'checkpointState', col: 10, title: 'Checkpoint State' },
  { key: 'lastRunMetrics', col: 11, title: 'Last Run Metrics' },
  { key: 'lastError', col: 12, title: 'Last Error' }
];

// ==========================================
// 1. SPREADSHEET MENU & SETTINGS
// ==========================================

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('🚀 AI Content Engine')
    .addItem('Phase 1: Generate Draft (v1)', 'runPhase1Draft')
    .addItem('Phase 2: SEO/GEO Optimize (v2)', 'runPhase2Optimize')
    .addSeparator()
    .addItem('🗑️ Clear Selected Row Checkpoint', 'clearSelectedRowCheckpoint')
    .addItem('🧪 Initialize Experiment_Config Tab', 'initExperimentConfigTab')
    .addItem('⚙️ Configure Settings', 'configureSettings')
    .addToUi();
}

function configureSettings() {
  const ui = SpreadsheetApp.getUi();
  const scriptProps = PropertiesService.getScriptProperties();

  const currentUrl = scriptProps.getProperty(PROPERTY_KEYS.CLOUD_RUN_URL) || '';
  const hasSecret = Boolean(scriptProps.getProperty(PROPERTY_KEYS.WEBHOOK_SHARED_SECRET));
  const currentTab = scriptProps.getProperty(PROPERTY_KEYS.TRACKER_SHEET_NAME) || 'Arical backlog';

  const urlResp = ui.prompt(
    '⚙️ Configure Cloud Run URL (1/3)',
    'Enter your Cloud Run base URL (e.g., https://your-service.a.run.app).\nLeave blank to keep current (' + (currentUrl || 'not set') + '):',
    ui.ButtonSet.OK_CANCEL
  );
  if (urlResp.getSelectedButton() !== ui.Button.OK) return;

  const secretResp = ui.prompt(
    '🔑 Configure Webhook Shared Secret (2/3)',
    'Enter X-Webhook-Secret matching GCP Secret Manager.\nLeave blank to keep current (' + (hasSecret ? '•••••••• configured' : 'NOT SET') + '):',
    ui.ButtonSet.OK_CANCEL
  );
  if (secretResp.getSelectedButton() !== ui.Button.OK) return;

  const tabResp = ui.prompt(
    '📋 Configure Tracker Tab Name (3/3)',
    'Enter exact tracker tab name.\nLeave blank to keep current (' + currentTab + '):',
    ui.ButtonSet.OK_CANCEL
  );
  if (tabResp.getSelectedButton() !== ui.Button.OK) return;

  const updates = {};
  const newUrl = urlResp.getResponseText().trim().replace(/\/+$/, '');
  const newSecret = secretResp.getResponseText().trim();
  const newTab = tabResp.getResponseText().trim();

  if (newUrl) {
    if (!/^https:\/\//i.test(newUrl)) {
      ui.alert('Invalid URL: CLOUD_RUN_URL must start with https://');
      return;
    }
    updates[PROPERTY_KEYS.CLOUD_RUN_URL] = newUrl;
  }
  if (newSecret) {
    updates[PROPERTY_KEYS.WEBHOOK_SHARED_SECRET] = newSecret;
  }
  if (newTab) {
    updates[PROPERTY_KEYS.TRACKER_SHEET_NAME] = newTab;
  } else if (!scriptProps.getProperty(PROPERTY_KEYS.TRACKER_SHEET_NAME)) {
    updates[PROPERTY_KEYS.TRACKER_SHEET_NAME] = currentTab;
  }

  if (Object.keys(updates).length > 0) {
    scriptProps.setProperties(updates, false);
  }

  ui.alert('Settings saved to ScriptProperties.');
}

function initExperimentConfigTab() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ui = SpreadsheetApp.getUi();
  const configTabName = getConfigSheetName_();
  let configSheet = ss.getSheetByName(configTabName);

  if (configSheet) {
    ui.alert('Tab "' + configTabName + '" already exists.');
    return;
  }

  configSheet = ss.insertSheet(configTabName);
  const headers = [
    'Experiment_ID',
    'Active',
    'Researcher_Doc_ID',
    'Planner_Doc_ID',
    'Writer_Doc_ID',
    'Optimizer_Doc_ID',
    'Draft_Folder_ID',
    'Final_Folder_ID',
    'Notes'
  ];
  const sampleRow = [
    'exp_v2_default',
    'TRUE',
    'REPLACE_WITH_AGENT_A_DOC_ID',
    'REPLACE_WITH_AGENT_B_DOC_ID',
    'REPLACE_WITH_AGENT_C_DOC_ID',
    'REPLACE_WITH_AGENT_D_DOC_ID',
    'REPLACE_WITH_DRAFT_FOLDER_ID',
    'REPLACE_WITH_FINAL_FOLDER_ID',
    'Default v2 pipeline config'
  ];

  configSheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
  configSheet.getRange(2, 1, 1, sampleRow.length).setValues([sampleRow]);
  configSheet.setFrozenRows(1);

  const protection = configSheet.protect().setDescription('Protected Experiment_Config');
  protection.setWarningOnly(true);

  ui.alert(
    'Created "' + configTabName + '" tab.\n\n' +
    'Fill in your Agent A-D Google Doc IDs (located inside ALLOWED_PROMPT_FOLDER_ID) and target Drive Folder IDs before running Phase 1 or Phase 2.'
  );
}

// ==========================================
// 2. PHASE 1: SPLIT-STAGE DRAFTING (v1) WITH CHECKPOINTING
// ==========================================

function runPhase1Draft() {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getActiveSheet();

  if (!isAllowedTrackerSheet_(sheet)) {
    ui.alert(
      'Wrong Sheet Tab!\n\nPlease switch to your content tracker tab before running Phase 1.\nActive tab: "' + sheet.getName() + '"'
    );
    return;
  }

  const row = sheet.getActiveCell().getRow();
  if (row < 2) {
    ui.alert('Please select a content row (Row 2 or below).');
    return;
  }

  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(5000)) {
    ui.alert('Concurrency Lock Active:\nAnother pipeline execution is currently running on this spreadsheet. Please wait for it to finish.');
    return;
  }

  let cols;
  let completedStageLabel = 'Initialization';

  try {
    const settings = getRequiredSettings_();
    cols = resolveAndEnsureColumns_(sheet);

    const topic = String(sheet.getRange(row, cols.topic).getValue() || '').trim();
    const coreFocus = String(sheet.getRange(row, cols.coreFocus).getValue() || '').trim();
    const description = String(sheet.getRange(row, cols.description).getValue() || '').trim();

    if (!topic) {
      ui.alert('Selected row (' + row + ') has no Topic.');
      return;
    }

    const rowExpId = String(sheet.getRange(row, cols.experimentId).getValue() || '').trim();
    const expConfig = getExperimentConfig_(ss, rowExpId, ['researcher', 'planner', 'writer', 'draftFolder']);
    sheet.getRange(row, cols.experimentId).setValue(expConfig.experimentId);

    const inputHash = computeInputHash_(topic, coreFocus, description, expConfig.experimentId);
    let checkpoint = loadRowCheckpoint_(row, inputHash);

    const draftCell = sheet.getRange(row, cols.v1DocUrl);
    const existingV1Url = String(draftCell.getValue() || '').trim();

    if (checkpoint && (checkpoint.research_dossier || checkpoint.editorial_blueprint)) {
      const resumeStage = checkpoint.editorial_blueprint ? 'Stage 3 (Writer)' : 'Stage 2 (Planner)';
      const resumeChoice = ui.alert(
        'Saved Checkpoint Found (Row ' + row + ')',
        'Found saved intermediate output ready to resume at ' + resumeStage + '.\n\n' +
        'Click YES to resume from ' + resumeStage + ' without re-running completed stages.\n' +
        'Click NO to discard the checkpoint and start fresh from Stage 1.',
        ui.ButtonSet.YES_NO_CANCEL
      );
      if (resumeChoice === ui.Button.CANCEL) {
        return;
      }
      if (resumeChoice === ui.Button.NO) {
        clearRowCheckpoint_(row);
        checkpoint = null;
        sheet.getRange(row, cols.checkpointState).setValue('Cleared (Restarting)');
      }
    } else if (existingV1Url && extractGoogleDocId(existingV1Url)) {
      const overwriteChoice = ui.alert(
        'Existing v1 Draft Detected',
        'Row ' + row + ' already has a v1 Draft link in Column D.\n\n' +
        'Generate a new v1 draft? (The existing URL will be preserved in the cell Note.)',
        ui.ButtonSet.YES_NO
      );
      if (overwriteChoice !== ui.Button.YES) {
        return;
      }
    }

    let researchDossier = checkpoint ? checkpoint.research_dossier : null;
    let editorialBlueprint = checkpoint ? checkpoint.editorial_blueprint : null;
    const metricsSummary = [];

    sheet.getRange(row, cols.lastError).setValue('');

    // --- Stage 1: Research ---
    if (!researchDossier) {
      completedStageLabel = 'Stage 1/3 (Research)';
      updateStatus_(sheet, row, cols.pipelineStatus, '⏳ Stage 1/3: Researching...');
      ss.toast('Stage 1/3: Running Researcher for "' + topic + '"', 'Phase 1', 8);

      const res1 = callCloudRunStage_(settings, {
        action: 'research',
        topic: topic,
        core_focus: coreFocus,
        description: description,
        prompt_doc_id: expConfig.researcherDocId
      });
      researchDossier = res1.output;
      metricsSummary.push(formatStageMetric_('S1', res1.metrics));

      checkpoint = saveRowCheckpoint_(row, expConfig.draftFolderId, {
        row: row,
        topic: topic,
        inputHash: inputHash,
        experimentId: expConfig.experimentId,
        research_dossier: researchDossier,
        editorial_blueprint: null,
        updatedAt: new Date().toISOString()
      });
      sheet.getRange(row, cols.checkpointState).setValue('Stage 1/3 Saved');
      SpreadsheetApp.flush();
    } else {
      metricsSummary.push('S1:cached');
    }

    // --- Stage 2: Plan ---
    if (!editorialBlueprint) {
      completedStageLabel = 'Stage 2/3 (Plan)';
      updateStatus_(sheet, row, cols.pipelineStatus, '⏳ Stage 2/3: Planning Blueprint...');
      ss.toast('Stage 2/3: Building Editorial Blueprint for "' + topic + '"', 'Phase 1', 8);

      const res2 = callCloudRunStage_(settings, {
        action: 'plan',
        topic: topic,
        core_focus: coreFocus,
        description: description,
        research_dossier: researchDossier,
        prompt_doc_id: expConfig.plannerDocId
      });
      editorialBlueprint = res2.output;
      metricsSummary.push(formatStageMetric_('S2', res2.metrics));

      checkpoint = saveRowCheckpoint_(row, expConfig.draftFolderId, {
        row: row,
        topic: topic,
        inputHash: inputHash,
        experimentId: expConfig.experimentId,
        research_dossier: researchDossier,
        editorial_blueprint: editorialBlueprint,
        updatedAt: new Date().toISOString()
      });
      sheet.getRange(row, cols.checkpointState).setValue('Stages 1-2 Saved');
      SpreadsheetApp.flush();
    } else {
      metricsSummary.push('S2:cached');
    }

    // --- Stage 3: Write ---
    completedStageLabel = 'Stage 3/3 (Write)';
    updateStatus_(sheet, row, cols.pipelineStatus, '⏳ Stage 3/3: Writing v1 Draft...');
    ss.toast('Stage 3/3: Writing full v1 Draft for "' + topic + '"', 'Phase 1', 8);

    const res3 = callCloudRunStage_(settings, {
      action: 'write',
      topic: topic,
      core_focus: coreFocus,
      description: description,
      research_dossier: researchDossier,
      editorial_blueprint: editorialBlueprint,
      prompt_doc_id: expConfig.writerDocId
    });
    const finalDraftMarkdown = res3.output;
    metricsSummary.push(formatStageMetric_('S3', res3.metrics));

    completedStageLabel = 'Creating Google Doc';
    const docTitle = topic + ' - v1 (Draft)';
    const v1DocUrl = createFormattedDocInFolder_(docTitle, finalDraftMarkdown, expConfig.draftFolderId);

    setUrlPreservingHistory_(draftCell, v1DocUrl);
    sheet.getRange(row, cols.approvalStatus).setValue('Pending Review');
    updateStatus_(sheet, row, cols.pipelineStatus, '✅ Phase 1 Complete');
    sheet.getRange(row, cols.lastRunMetrics).setValue(
      formatTimestamp_() + ' | ' + metricsSummary.join(' | ')
    );

    clearRowCheckpoint_(row);
    sheet.getRange(row, cols.checkpointState).setValue('Cleared (Completed)');
    SpreadsheetApp.flush();

    ui.alert(
      'Phase 1 Complete!\n\n' +
      'Draft v1 created: ' + v1DocUrl + '\n\n' +
      'Review and edit the Doc, resolve all comments, and set Column E to "Approved" before running Phase 2.'
    );
  } catch (error) {
    if (cols) {
      const hasSavedCheckpoint = Boolean(
        PropertiesService.getDocumentProperties().getProperty(getCheckpointPropKey_(row))
      );
      const suffix = hasSavedCheckpoint ? ' (Checkpoint saved — re-run to resume)' : '';
      updateStatus_(sheet, row, cols.pipelineStatus, '❌ Failed at ' + completedStageLabel + suffix);
      sheet.getRange(row, cols.lastError).setValue(
        '[' + formatTimestamp_() + '] ' + error.message
      );
      SpreadsheetApp.flush();
    }
    ui.alert('Phase 1 Failed [' + completedStageLabel + ']:\n\n' + error.message);
  } finally {
    lock.releaseLock();
  }
}

// ==========================================
// 3. PHASE 2: SEO / GEO OPTIMIZATION (v2)
// ==========================================

function runPhase2Optimize() {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getActiveSheet();

  if (!isAllowedTrackerSheet_(sheet)) {
    ui.alert(
      'Wrong Sheet Tab!\n\nPlease switch to your content tracker tab before running Phase 2.\nActive tab: "' + sheet.getName() + '"'
    );
    return;
  }

  const row = sheet.getActiveCell().getRow();
  if (row < 2) {
    ui.alert('Please select a content row (Row 2 or below).');
    return;
  }

  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(5000)) {
    ui.alert('Concurrency Lock Active:\nAnother pipeline execution is currently running on this spreadsheet. Please wait for it to finish.');
    return;
  }

  let cols;

  try {
    const settings = getRequiredSettings_();
    cols = resolveAndEnsureColumns_(sheet);

    const topic = String(sheet.getRange(row, cols.topic).getValue() || '').trim();
    const coreFocus = String(sheet.getRange(row, cols.coreFocus).getValue() || '').trim();
    const description = String(sheet.getRange(row, cols.description).getValue() || '').trim();
    const v1DocUrl = String(sheet.getRange(row, cols.v1DocUrl).getValue() || '').trim();
    const approvalRaw = String(sheet.getRange(row, cols.approvalStatus).getValue() || '').trim();

    if (!topic) {
      ui.alert('Selected row (' + row + ') has no Topic.');
      return;
    }

    // Normalized Human-in-the-Loop Approval Gate
    if (approvalRaw.toLowerCase() !== 'approved') {
      ui.alert(
        'Approval Gate Blocked!\n\n' +
        'Human Edits status must be "Approved" before running Phase 2.\n' +
        'Current value: "' + (approvalRaw || '(empty)') + '"'
      );
      return;
    }

    const v1DocId = extractGoogleDocId(v1DocUrl);
    if (!v1DocId) {
      ui.alert(
        'Invalid v1 Draft Link!\n\nColumn D does not contain a recognizable Google Doc URL (/document/d/... or ?id=...).'
      );
      return;
    }

    // Unresolved Google Docs Reviewer Comments Gate (Drive v3)
    const unresolvedComments = listUnresolvedComments_(v1DocId);
    if (unresolvedComments.length > 0) {
      updateStatus_(
        sheet,
        row,
        cols.pipelineStatus,
        '⏸️ Blocked: ' + unresolvedComments.length + ' Unresolved Comment(s)'
      );
      const preview = unresolvedComments
        .slice(0, 3)
        .map(function (c, idx) {
          const author = (c.author && c.author.displayName) ? c.author.displayName : 'Reviewer';
          const snippet = String(c.content || '').replace(/\s+/g, ' ').substring(0, 90);
          return (idx + 1) + '. [' + author + ']: "' + snippet + '"';
        })
        .join('\n');

      ui.alert(
        'Unresolved Comments Gate Blocked!\n\n' +
        'The v1 Draft has ' + unresolvedComments.length + ' unresolved comment(s). ' +
        'Please resolve or address all reviewer comments in Google Docs before running Phase 2:\n\n' +
        preview
      );
      return;
    }

    const rowExpId = String(sheet.getRange(row, cols.experimentId).getValue() || '').trim();
    const expConfig = getExperimentConfig_(ss, rowExpId, ['optimizer', 'finalFolder']);
    sheet.getRange(row, cols.experimentId).setValue(expConfig.experimentId);

    const finalDocCell = sheet.getRange(row, cols.v2DocUrl);
    const existingV2Url = String(finalDocCell.getValue() || '').trim();
    if (existingV2Url && extractGoogleDocId(existingV2Url)) {
      const overwriteChoice = ui.alert(
        'Existing v2 Final Doc Detected',
        'Row ' + row + ' already has a Reviewed Doc link in Column F.\n\n' +
        'Generate a new v2 optimized Doc? (The existing URL will be preserved in the cell Note.)',
        ui.ButtonSet.YES_NO
      );
      if (overwriteChoice !== ui.Button.YES) {
        return;
      }
    }

    sheet.getRange(row, cols.lastError).setValue('');
    updateStatus_(sheet, row, cols.pipelineStatus, '⏳ Phase 2: Optimizing SEO/GEO...');
    SpreadsheetApp.flush();
    ss.toast('Running Phase 2 (SEO/GEO Optimization) for "' + topic + '"', 'Phase 2', 8);

    const humanEditedDraft = DocumentApp.openById(v1DocId).getBody().getText();
    if (!humanEditedDraft.trim()) {
      throw new Error('The approved v1 Google Doc (' + v1DocId + ') is empty.');
    }

    const res = callCloudRunStage_(settings, {
      action: 'optimize',
      topic: topic,
      core_focus: coreFocus,
      description: description,
      draft_text: humanEditedDraft,
      prompt_doc_id: expConfig.optimizerDocId
    });

    const docTitle = topic + ' - v2 (Final)';
    const v2DocUrl = createFormattedDocInFolder_(docTitle, res.output, expConfig.finalFolderId);

    setUrlPreservingHistory_(finalDocCell, v2DocUrl);
    sheet.getRange(row, cols.humanReview).setValue('Ready for CMS');
    updateStatus_(sheet, row, cols.pipelineStatus, '✅ Phase 2 Complete');
    sheet.getRange(row, cols.lastRunMetrics).setValue(
      formatTimestamp_() + ' | ' + formatStageMetric_('S4', res.metrics)
    );
    SpreadsheetApp.flush();

    ui.alert('Phase 2 Complete!\n\nFinal v2 Doc created: ' + v2DocUrl);
  } catch (error) {
    if (cols) {
      updateStatus_(sheet, row, cols.pipelineStatus, '❌ Phase 2 Failed');
      sheet.getRange(row, cols.lastError).setValue(
        '[' + formatTimestamp_() + '] ' + error.message
      );
      SpreadsheetApp.flush();
    }
    ui.alert('Phase 2 Failed:\n\n' + error.message);
  } finally {
    lock.releaseLock();
  }
}

function clearSelectedRowCheckpoint() {
  const ui = SpreadsheetApp.getUi();
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  if (!isAllowedTrackerSheet_(sheet)) {
    ui.alert('Switch to the content tracker tab first.');
    return;
  }
  const row = sheet.getActiveCell().getRow();
  if (row < 2) {
    ui.alert('Select a data row (Row 2 or below).');
    return;
  }
  const cols = resolveAndEnsureColumns_(sheet);
  clearRowCheckpoint_(row);
  sheet.getRange(row, cols.checkpointState).setValue('Cleared Manually');
  ui.alert('Cleared saved checkpoint for Row ' + row + '.');
}

// ==========================================
// 4. CLOUD RUN CLIENT (AUTHENTICATED)
// ==========================================

function getRequiredSettings_() {
  const props = PropertiesService.getScriptProperties();
  const cloudRunUrl = (props.getProperty(PROPERTY_KEYS.CLOUD_RUN_URL) || '').trim().replace(/\/+$/, '');
  const webhookSecret = (props.getProperty(PROPERTY_KEYS.WEBHOOK_SHARED_SECRET) || '').trim();

  if (!cloudRunUrl || !webhookSecret) {
    throw new Error(
      'Missing ScriptProperties configuration. Run "🚀 AI Content Engine -> ⚙️ Configure Settings" to set CLOUD_RUN_URL and WEBHOOK_SHARED_SECRET.'
    );
  }

  return {
    cloudRunUrl: cloudRunUrl,
    webhookSecret: webhookSecret
  };
}

function callCloudRunStage_(settings, payload) {
  const endpoint = settings.cloudRunUrl + '/stage';
  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'X-Webhook-Secret': settings.webhookSecret
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  const response = UrlFetchApp.fetch(endpoint, options);
  const responseCode = response.getResponseCode();
  const bodyText = response.getContentText();

  let json;
  try {
    json = JSON.parse(bodyText);
  } catch (e) {
    throw new Error(
      'Non-JSON response from Cloud Run (HTTP ' + responseCode + '): ' + bodyText.substring(0, 250)
    );
  }

  if (responseCode !== 200 || json.status === 'error') {
    const stage = json.failed_stage || payload.action || 'Stage';
    const details = json.error_details || json.error || ('HTTP ' + responseCode);
    throw new Error('[' + stage + '] ' + details);
  }

  const output = json.output || json.article;
  if (!output) {
    throw new Error("Cloud Run response missing 'output' field.");
  }

  return {
    output: output,
    metrics: json.metrics || {}
  };
}

// ==========================================
// 5. EXPERIMENT CONFIG & SHEET SCHEMA HELPERS
// ==========================================

function getConfigSheetName_() {
  return (
    PropertiesService.getScriptProperties().getProperty(PROPERTY_KEYS.CONFIG_SHEET_NAME) ||
    DEFAULT_CONFIG_SHEET_NAME
  ).trim();
}

function isAllowedTrackerSheet_(sheet) {
  const activeName = sheet.getName().trim().toLowerCase();
  if (activeName === getConfigSheetName_().toLowerCase() || activeName === 'topic backlog') {
    return false;
  }
  const configured = (
    PropertiesService.getScriptProperties().getProperty(PROPERTY_KEYS.TRACKER_SHEET_NAME) || ''
  ).trim().toLowerCase();

  if (configured) {
    return activeName === configured;
  }
  return DEFAULT_ALLOWED_TRACKER_TABS.indexOf(activeName) !== -1;
}

function resolveAndEnsureColumns_(sheet) {
  const maxCol = Math.max(sheet.getLastColumn(), 12);
  const headerValues = sheet.getRange(1, 1, 1, maxCol).getValues()[0];
  const normalizedMap = {};

  for (let i = 0; i < headerValues.length; i++) {
    const clean = String(headerValues[i] || '').trim().toLowerCase();
    if (clean) {
      normalizedMap[clean] = i + 1;
    }
  }

  function findCol(aliasList, fallbackCol) {
    for (let i = 0; i < aliasList.length; i++) {
      if (normalizedMap[aliasList[i]]) {
        return normalizedMap[aliasList[i]];
      }
    }
    return fallbackCol;
  }

  const resolved = {
    topic: findCol(HEADER_ALIASES.topic, 1),
    coreFocus: findCol(HEADER_ALIASES.coreFocus, 2),
    description: findCol(HEADER_ALIASES.description, 3),
    v1DocUrl: findCol(HEADER_ALIASES.v1DocUrl, 4),
    approvalStatus: findCol(HEADER_ALIASES.approvalStatus, 5),
    v2DocUrl: findCol(HEADER_ALIASES.v2DocUrl, 6),
    humanReview: findCol(HEADER_ALIASES.humanReview, 7)
  };

  for (let i = 0; i < STATUS_COLUMN_DEFAULTS.length; i++) {
    const spec = STATUS_COLUMN_DEFAULTS[i];
    const existingCol = findCol(HEADER_ALIASES[spec.key], 0);
    if (existingCol > 0) {
      resolved[spec.key] = existingCol;
    } else {
      let targetCol = spec.col;
      while (String(sheet.getRange(1, targetCol).getValue() || '').trim() !== '') {
        targetCol++;
      }
      sheet.getRange(1, targetCol).setValue(spec.title).setFontWeight('bold');
      resolved[spec.key] = targetCol;
    }
  }

  return resolved;
}

function getExperimentConfig_(ss, requestedExpId, requiredFields) {
  const configTabName = getConfigSheetName_();
  const configSheet = ss.getSheetByName(configTabName);
  if (!configSheet) {
    throw new Error(
      'Missing "' + configTabName + '" tab. Use "🚀 AI Content Engine -> 🧪 Initialize Experiment_Config Tab" first.'
    );
  }

  const data = configSheet.getDataRange().getValues();
  if (data.length < 2) {
    throw new Error('"' + configTabName + '" tab has no configuration rows.');
  }

  const headers = data[0].map(function (h) {
    return String(h || '').trim().toLowerCase();
  });

  function colIdx(name) {
    return headers.indexOf(name.toLowerCase());
  }

  const idxExpId = colIdx('experiment_id');
  const idxActive = colIdx('active');
  const idxRes = colIdx('researcher_doc_id');
  const idxPlan = colIdx('planner_doc_id');
  const idxWrite = colIdx('writer_doc_id');
  const idxOpt = colIdx('optimizer_doc_id');
  const idxDraftFolder = colIdx('draft_folder_id');
  const idxFinalFolder = colIdx('final_folder_id');

  if (idxExpId === -1 || idxDraftFolder === -1) {
    throw new Error('"' + configTabName + '" is missing required columns (Experiment_ID, Draft_Folder_ID, etc.).');
  }

  let matchedRow = null;
  for (let r = 1; r < data.length; r++) {
    const rowValues = data[r];
    const expId = String(rowValues[idxExpId] || '').trim();
    if (!expId) continue;

    if (requestedExpId && expId.toLowerCase() === requestedExpId.toLowerCase()) {
      matchedRow = rowValues;
      break;
    }
    if (!requestedExpId && !matchedRow) {
      const activeVal = idxActive >= 0 ? String(rowValues[idxActive] || '').trim().toLowerCase() : '';
      if (activeVal === 'true' || activeVal === 'yes' || activeVal === '1') {
        matchedRow = rowValues;
      }
    }
  }

  if (!matchedRow) {
    throw new Error(
      requestedExpId
        ? 'Experiment_ID "' + requestedExpId + '" was not found in "' + configTabName + '".'
        : 'No active row (Active = TRUE) found in "' + configTabName + '".'
    );
  }

  const draftFolderId = cleanDriveId_(matchedRow[idxDraftFolder]);
  const finalFolderRaw = idxFinalFolder >= 0 ? cleanDriveId_(matchedRow[idxFinalFolder]) : '';

  const cfg = {
    experimentId: String(matchedRow[idxExpId]).trim(),
    researcherDocId: idxRes >= 0 ? cleanDriveId_(matchedRow[idxRes]) : '',
    plannerDocId: idxPlan >= 0 ? cleanDriveId_(matchedRow[idxPlan]) : '',
    writerDocId: idxWrite >= 0 ? cleanDriveId_(matchedRow[idxWrite]) : '',
    optimizerDocId: idxOpt >= 0 ? cleanDriveId_(matchedRow[idxOpt]) : '',
    draftFolderId: draftFolderId,
    finalFolderId: finalFolderRaw || draftFolderId
  };

  const checkMap = {
    researcher: { val: cfg.researcherDocId, label: 'Researcher_Doc_ID' },
    planner: { val: cfg.plannerDocId, label: 'Planner_Doc_ID' },
    writer: { val: cfg.writerDocId, label: 'Writer_Doc_ID' },
    optimizer: { val: cfg.optimizerDocId, label: 'Optimizer_Doc_ID' },
    draftFolder: { val: cfg.draftFolderId, label: 'Draft_Folder_ID' },
    finalFolder: { val: cfg.finalFolderId, label: 'Final_Folder_ID' }
  };

  for (let i = 0; i < requiredFields.length; i++) {
    const entry = checkMap[requiredFields[i]];
    if (!entry.val || entry.val.indexOf('REPLACE_WITH') === 0) {
      throw new Error(
        'Configuration Error in "' + configTabName + '" (' + cfg.experimentId + '): ' +
        entry.label + ' is missing or still set to a placeholder.'
      );
    }
  }

  return cfg;
}

function cleanDriveId_(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.indexOf('REPLACE_WITH') === 0) return raw;
  const extracted = extractGoogleDocId(raw);
  return extracted || raw;
}

// ==========================================
// 6. INTERMEDIATE STAGE CHECKPOINTING (DRIVE + PROPERTIES)
// ==========================================

function getCheckpointPropKey_(row) {
  return 'HITL_STAGE_CHECKPOINT_ROW_' + row;
}

function computeInputHash_(topic, coreFocus, description, experimentId) {
  const digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    [topic, coreFocus, description, experimentId].join('||'),
    Utilities.Charset.UTF_8
  );
  return digest
    .map(function (b) {
      return ('0' + (b & 0xff).toString(16)).slice(-2);
    })
    .join('');
}

function loadRowCheckpoint_(row, expectedInputHash) {
  const docProps = PropertiesService.getDocumentProperties();
  const rawPointer = docProps.getProperty(getCheckpointPropKey_(row));
  if (!rawPointer) return null;

  try {
    const pointer = JSON.parse(rawPointer);
    if (!pointer || pointer.inputHash !== expectedInputHash || !pointer.fileId) {
      return null;
    }
    const contentText = DriveApp.getFileById(pointer.fileId).getBlob().getDataAsString('UTF-8');
    const data = JSON.parse(contentText);
    if (data.inputHash !== expectedInputHash) {
      return null;
    }
    data.fileId = pointer.fileId;
    return data;
  } catch (e) {
    docProps.deleteProperty(getCheckpointPropKey_(row));
    return null;
  }
}

function saveRowCheckpoint_(row, folderId, stateObj) {
  const docProps = PropertiesService.getDocumentProperties();
  const propKey = getCheckpointPropKey_(row);
  const existingRaw = docProps.getProperty(propKey);
  let existingFileId = null;

  if (existingRaw) {
    try {
      existingFileId = JSON.parse(existingRaw).fileId || null;
    } catch (e) {
      existingFileId = null;
    }
  }

  const fileName = '.hitl_checkpoint_row_' + row + '.json';
  const blob = Utilities.newBlob(JSON.stringify(stateObj), 'application/json', fileName);
  let fileId = existingFileId;

  if (fileId) {
    try {
      Drive.Files.update(
        { name: fileName },
        fileId,
        blob,
        { fields: 'id', supportsAllDrives: true }
      );
    } catch (e) {
      fileId = null;
    }
  }

  if (!fileId) {
    const created = Drive.Files.create(
      {
        name: fileName,
        mimeType: 'application/json',
        parents: [folderId]
      },
      blob,
      { fields: 'id', supportsAllDrives: true }
    );
    fileId = created.id;
  }

  docProps.setProperty(
    propKey,
    JSON.stringify({
      fileId: fileId,
      inputHash: stateObj.inputHash,
      experimentId: stateObj.experimentId,
      updatedAt: stateObj.updatedAt
    })
  );

  stateObj.fileId = fileId;
  return stateObj;
}

function clearRowCheckpoint_(row) {
  const docProps = PropertiesService.getDocumentProperties();
  const propKey = getCheckpointPropKey_(row);
  const rawPointer = docProps.getProperty(propKey);

  if (rawPointer) {
    try {
      const pointer = JSON.parse(rawPointer);
      if (pointer && pointer.fileId) {
        Drive.Files.update(
          { trashed: true },
          pointer.fileId,
          null,
          { supportsAllDrives: true }
        );
      }
    } catch (e) {
      // Ignore cleanup errors if temp file was already deleted
    }
    docProps.deleteProperty(propKey);
  }
}

// ==========================================
// 7. DRIVE v3 COMMENTS, URL PARSING & MARKDOWN->DOCS IMPORT
// ==========================================

/**
 * Extracts a Google Drive/Docs ID from `/document/d/<ID>`, `open?id=<ID>`, `/folders/<ID>`, or a bare ID.
 */
function extractGoogleDocId(urlOrId) {
  const raw = String(urlOrId || '').trim();
  if (!raw) return null;

  const urlMatch = raw.match(/(?:\/document\/d\/|\/folders\/|[?&]id=)([a-zA-Z0-9_-]{20,})/);
  if (urlMatch) {
    return urlMatch[1];
  }
  if (/^[a-zA-Z0-9_-]{20,}$/.test(raw)) {
    return raw;
  }
  return null;
}

function listUnresolvedComments_(fileId) {
  const unresolved = [];
  let pageToken = null;

  do {
    const resp = Drive.Comments.list(fileId, {
      fields: 'comments(id,content,resolved,deleted,author(displayName)),nextPageToken',
      includeDeleted: false,
      pageSize: 100,
      pageToken: pageToken || undefined
    });
    const comments = (resp && resp.comments) || [];
    for (let i = 0; i < comments.length; i++) {
      const c = comments[i];
      if (!c.deleted && c.resolved !== true) {
        unresolved.push(c);
      }
    }
    pageToken = resp ? resp.nextPageToken : null;
  } while (pageToken);

  return unresolved;
}

function createFormattedDocInFolder_(docTitle, markdownText, targetFolderId) {
  const html = convertMarkdownToHtml_(markdownText);
  const htmlBlob = Utilities.newBlob(html, 'text/html', docTitle + '.html');

  const created = Drive.Files.create(
    {
      name: docTitle,
      mimeType: 'application/vnd.google-apps.document',
      parents: [targetFolderId]
    },
    htmlBlob,
    {
      fields: 'id,webViewLink',
      supportsAllDrives: true
    }
  );

  return created.webViewLink || ('https://docs.google.com/document/d/' + created.id + '/edit');
}

function convertMarkdownToHtml_(markdown) {
  const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
  const htmlParts = [
    '<!DOCTYPE html><html><head><meta charset="UTF-8">',
    '<style>',
    'body { font-family: Arial, sans-serif; font-size: 11pt; line-height: 1.5; color: #202124; }',
    'h1 { font-size: 22pt; margin-top: 18pt; margin-bottom: 8pt; }',
    'h2 { font-size: 16pt; margin-top: 16pt; margin-bottom: 6pt; }',
    'h3 { font-size: 13pt; margin-top: 12pt; margin-bottom: 4pt; }',
    'blockquote { border-left: 3px solid #dadce0; padding-left: 10pt; color: #3c4043; margin: 10pt 0; }',
    'table { border-collapse: collapse; width: 100%; margin: 12pt 0; }',
    'th, td { border: 1px solid #dadce0; padding: 6pt 8pt; text-align: left; vertical-align: top; }',
    'th { background-color: #f1f3f4; font-weight: bold; }',
    'pre, code { font-family: "Courier New", monospace; background-color: #f8f9fa; }',
    'pre { padding: 8pt; border: 1px solid #e8eaed; }',
    '</style></head><body>'
  ];

  let inCodeBlock = false;
  let codeLines = [];
  let inUl = false;
  let inOl = false;
  let tableRows = [];
  let paragraphBuffer = [];

  function flushParagraph() {
    if (paragraphBuffer.length > 0) {
      htmlParts.push('<p>' + formatInlineMarkdown_(paragraphBuffer.join(' ')) + '</p>');
      paragraphBuffer = [];
    }
  }

  function closeLists() {
    if (inUl) {
      htmlParts.push('</ul>');
      inUl = false;
    }
    if (inOl) {
      htmlParts.push('</ol>');
      inOl = false;
    }
  }

  function flushTable() {
    if (tableRows.length === 0) return;
    htmlParts.push('<table>');
    let bodyStart = 0;
    if (
      tableRows.length >= 2 &&
      tableRows[1].every(function (cell) {
        return /^:?-{3,}:?$/.test(cell.trim());
      })
    ) {
      htmlParts.push('<thead><tr>');
      for (let c = 0; c < tableRows[0].length; c++) {
        htmlParts.push('<th>' + formatInlineMarkdown_(tableRows[0][c].trim()) + '</th>');
      }
      htmlParts.push('</tr></thead>');
      bodyStart = 2;
    }
    htmlParts.push('<tbody>');
    for (let r = bodyStart; r < tableRows.length; r++) {
      htmlParts.push('<tr>');
      for (let c = 0; c < tableRows[r].length; c++) {
        htmlParts.push('<td>' + formatInlineMarkdown_(tableRows[r][c].trim()) + '</td>');
      }
      htmlParts.push('</tr>');
    }
    htmlParts.push('</tbody></table>');
    tableRows = [];
  }

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    if (/^```/.test(trimmed)) {
      flushParagraph();
      closeLists();
      flushTable();
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeLines = [];
      } else {
        htmlParts.push('<pre><code>' + escapeHtml_(codeLines.join('\n')) + '</code></pre>');
        inCodeBlock = false;
      }
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(rawLine);
      continue;
    }

    // Markdown table row
    if (/^\|(.+)\|$/.test(trimmed)) {
      flushParagraph();
      closeLists();
      const cells = trimmed.slice(1, -1).split('|');
      tableRows.push(cells);
      continue;
    } else if (tableRows.length > 0) {
      flushTable();
    }

    if (trimmed === '') {
      flushParagraph();
      closeLists();
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flushParagraph();
      closeLists();
      htmlParts.push('<hr/>');
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      flushParagraph();
      closeLists();
      const level = headingMatch[1].length;
      htmlParts.push('<h' + level + '>' + formatInlineMarkdown_(headingMatch[2].trim()) + '</h' + level + '>');
      continue;
    }

    const quoteMatch = trimmed.match(/^>\s?(.*)$/);
    if (quoteMatch) {
      flushParagraph();
      closeLists();
      htmlParts.push('<blockquote><p>' + formatInlineMarkdown_(quoteMatch[1]) + '</p></blockquote>');
      continue;
    }

    const ulMatch = trimmed.match(/^[-*+]\s+(.+)$/);
    if (ulMatch) {
      flushParagraph();
      if (inOl) {
        htmlParts.push('</ol>');
        inOl = false;
      }
      if (!inUl) {
        htmlParts.push('<ul>');
        inUl = true;
      }
      htmlParts.push('<li>' + formatInlineMarkdown_(ulMatch[1]) + '</li>');
      continue;
    }

    const olMatch = trimmed.match(/^\d+\.\s+(.+)$/);
    if (olMatch) {
      flushParagraph();
      if (inUl) {
        htmlParts.push('</ul>');
        inUl = false;
      }
      if (!inOl) {
        htmlParts.push('<ol>');
        inOl = true;
      }
      htmlParts.push('<li>' + formatInlineMarkdown_(olMatch[1]) + '</li>');
      continue;
    }

    paragraphBuffer.push(trimmed);
  }

  if (inCodeBlock && codeLines.length > 0) {
    htmlParts.push('<pre><code>' + escapeHtml_(codeLines.join('\n')) + '</code></pre>');
  }
  flushParagraph();
  closeLists();
  flushTable();

  htmlParts.push('</body></html>');
  return htmlParts.join('\n');
}

function escapeHtml_(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatInlineMarkdown_(text) {
  let escaped = escapeHtml_(text);
  // Inline code
  escaped = escaped.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Links [label](https://...)
  escaped = escaped.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2">$1</a>'
  );
  // Bold **text**
  escaped = escaped.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // Italic *text*
  escaped = escaped.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, '$1<em>$2</em>');
  return escaped;
}

// ==========================================
// 8. NON-DESTRUCTIVE CELL & METRICS HELPERS
// ==========================================

function setUrlPreservingHistory_(cell, newUrl) {
  const priorVal = String(cell.getValue() || '').trim();
  if (priorVal && priorVal !== newUrl && /^https?:\/\//i.test(priorVal)) {
    const existingNote = String(cell.getNote() || '').trim();
    const archiveEntry = '[' + formatTimestamp_() + '] Prior URL: ' + priorVal;
    cell.setNote(existingNote ? (existingNote + '\n' + archiveEntry) : archiveEntry);
  }
  cell.setValue(newUrl);
}

function updateStatus_(sheet, row, statusCol, message) {
  sheet.getRange(row, statusCol).setValue(message);
}

function formatStageMetric_(prefix, metrics) {
  if (!metrics || typeof metrics !== 'object') return prefix + ':ok';
  const sec = metrics.duration_ms ? (metrics.duration_ms / 1000).toFixed(1) + 's' : '?s';
  const tok = metrics.total_tokens ? metrics.total_tokens + 'tok' : '';
  return prefix + ':' + sec + (tok ? '(' + tok + ')' : '');
}

function formatTimestamp_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'UTC', 'yyyy-MM-dd HH:mm');
}
