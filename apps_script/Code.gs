/**
 * HUMAN-IN-THE-LOOP (HITL) B2B CONTENT PUBLISHING ENGINE
 * Google Sheets -> Apps Script (Code.gs) -> Cloud Run (main.py) -> Google Docs
 */

// ==========================================
// 1. CONFIGURATION & IDs
// ==========================================
const CLOUD_RUN_URL = 'https://crewai-blog-webhook-782827619242.europe-west1.run.app';
const DESTINATION_FOLDER_ID = '16Xf2F8orcvEsSeQK5k40_uXu4d2o25en';

const PROMPT_DOC_IDS = {
  RESEARCHER: '1myPY_C7bTOf-pBh6UZT5OEYfFX1Jgrn2-PpDt1JIk00',
  PLANNER: '1OSwiDLVLPlWi-t8Noz81Ov0IcPWVjFU2n6IJW77hpYo',
  WRITER: '1LFO94HFl2aJWxK6qBgpXgnCRsbtPlJlqLrLQi21y4yI',
  OPTIMIZER: 'REPLACE_WITH_YOUR_AGENT_D_OPTIMIZER_DOC_ID'
};

// ==========================================
// 2. SPREADSHEET MENU
// ==========================================
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('🚀 AI Content Engine')
    .addItem('Phase 1: Generate Draft', 'runPhase1Draft')
    .addItem('Phase 2: SEO/GEO Optimize', 'runPhase2Optimize')
    .addToUi();
}

// ==========================================
// 3. PHASE 1: AUTOMATED DRAFTING (v1)
// ==========================================
function runPhase1Draft() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  const row = sheet.getActiveCell().getRow();

  if (row < 2) {
    SpreadsheetApp.getUi().alert('Please select a data row (row 2 or below).');
    return;
  }

  const topic = String(sheet.getRange(row, 1).getValue()).trim();
  const coreFocus = String(sheet.getRange(row, 2).getValue()).trim();
  const description = String(sheet.getRange(row, 3).getValue()).trim();

  if (!topic) {
    SpreadsheetApp.getUi().alert('Selected row has no Topic in Column A.');
    return;
  }

  const draftCell = sheet.getRange(row, 4);     // Column D: Output Doc Link
  const approvalCell = sheet.getRange(row, 5);  // Column E: Human Edits

  draftCell.setValue('⏳ AI is drafting v1...');
  SpreadsheetApp.flush();
  SpreadsheetApp.getActiveSpreadsheet().toast('Running Phase 1 (Research -> Plan -> Write) for: ' + topic, 'Phase 1 Started', 8);

  try {
    const payload = {
      action: 'draft',
      topic: topic,
      core_focus: coreFocus,
      description: description,
      research_prompt: getDocText(PROMPT_DOC_IDS.RESEARCHER),
      plan_prompt: getDocText(PROMPT_DOC_IDS.PLANNER),
      writer_prompt: getDocText(PROMPT_DOC_IDS.WRITER)
    };

    const articleText = callCloudRunApi(payload);
    const docTitle = topic + ' - v1 (Draft)';
    const docUrl = saveToTargetFolder(docTitle, articleText);

    draftCell.setValue(docUrl);
    approvalCell.setValue('Pending Review');

    SpreadsheetApp.getUi().alert('Phase 1 Complete!\n\nDraft v1 created: ' + docUrl + '\n\nReview the doc, then set Column E to "Approved" before running Phase 2.');
  } catch (error) {
    draftCell.setValue('❌ Error: ' + error.message);
    SpreadsheetApp.getUi().alert('Phase 1 Failed:\n' + error.message);
  }
}

// ==========================================
// 4. PHASE 2: SEO / GEO OPTIMIZATION (v2)
// ==========================================
function runPhase2Optimize() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  const row = sheet.getActiveCell().getRow();

  if (row < 2) {
    SpreadsheetApp.getUi().alert('Please select a data row (row 2 or below).');
    return;
  }

  const topic = String(sheet.getRange(row, 1).getValue()).trim();
  const coreFocus = String(sheet.getRange(row, 2).getValue()).trim();
  const description = String(sheet.getRange(row, 3).getValue()).trim();
  const v1DocUrl = String(sheet.getRange(row, 4).getValue()).trim();
  const approvalStatus = String(sheet.getRange(row, 5).getValue()).trim();

  // Mandatory Human-in-the-Loop Gate
  if (approvalStatus !== 'Approved') {
    SpreadsheetApp.getUi().alert(
      'Approval Gate Blocked!\n\nColumn E (Human Edits) must be set to exactly "Approved" before running Phase 2.\nCurrent value: "' + approvalStatus + '"'
    );
    return;
  }

  if (!v1DocUrl || !v1DocUrl.includes('docs.google.com/document/d/')) {
    SpreadsheetApp.getUi().alert('Column D does not contain a valid Google Doc URL for the v1 draft.');
    return;
  }

  if (PROMPT_DOC_IDS.OPTIMIZER === 'REPLACE_WITH_YOUR_AGENT_D_OPTIMIZER_DOC_ID') {
    SpreadsheetApp.getUi().alert('Configuration Error: Set PROMPT_DOC_IDS.OPTIMIZER in Code.gs first.');
    return;
  }

  const finalDocCell = sheet.getRange(row, 6);   // Column F: Reviewed Doc Link
  const humanReviewCell = sheet.getRange(row, 7); // Column G: Human Review

  finalDocCell.setValue('⏳ AI is optimizing v2...');
  SpreadsheetApp.flush();
  SpreadsheetApp.getActiveSpreadsheet().toast('Running Phase 2 (SEO/GEO Optimization) for: ' + topic, 'Phase 2 Started', 8);

  try {
    const humanEditedDraft = DocumentApp.openByUrl(v1DocUrl).getBody().getText();

    if (!humanEditedDraft.trim()) {
      throw new Error('The v1 Google Doc in Column D is empty.');
    }

    const payload = {
      action: 'optimize',
      topic: topic,
      core_focus: coreFocus,
      description: description,
      draft_text: humanEditedDraft,
      optimizer_prompt: getDocText(PROMPT_DOC_IDS.OPTIMIZER)
    };

    const optimizedArticle = callCloudRunApi(payload);
    const docTitle = topic + ' - v2 (Final)';
    const v2DocUrl = saveToTargetFolder(docTitle, optimizedArticle);

    finalDocCell.setValue(v2DocUrl);
    humanReviewCell.setValue('Ready for CMS');

    SpreadsheetApp.getUi().alert('Phase 2 Complete!\n\nFinal v2 Doc created: ' + v2DocUrl);
  } catch (error) {
    finalDocCell.setValue('❌ Error: ' + error.message);
    SpreadsheetApp.getUi().alert('Phase 2 Failed:\n' + error.message);
  }
}

// ==========================================
// 5. CLOUD RUN HTTP CLIENT
// ==========================================
function callCloudRunApi(payload) {
  const options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
    timeoutSeconds: 360
  };

  const response = UrlFetchApp.fetch(CLOUD_RUN_URL, options);
  const responseCode = response.getResponseCode();
  const jsonText = response.getContentText();

  let json;
  try {
    json = JSON.parse(jsonText);
  } catch (e) {
    throw new Error('Invalid JSON from Cloud Run (' + responseCode + '): ' + jsonText.substring(0, 300));
  }

  if (responseCode !== 200 || json.status === 'error') {
    const stage = json.failed_stage || 'Execution';
    const details = json.error_details || json.error || jsonText;
    throw new Error('Cloud Run Error [' + stage + ']: ' + details);
  }

  if (!json.article) {
    throw new Error("Cloud Run response missing 'article' field.");
  }

  return json.article;
}

// ==========================================
// 6. GOOGLE DRIVE & DOCS HELPERS
// ==========================================
function getDocText(docId) {
  return DocumentApp.openById(docId).getBody().getText();
}

function saveToTargetFolder(docTitle, content) {
  const doc = DocumentApp.create(docTitle);
  const docFile = DriveApp.getFileById(doc.getId());
  const targetFolder = DriveApp.getFolderById(DESTINATION_FOLDER_ID);

  docFile.moveTo(targetFolder);
  doc.getBody().setText(content);
  doc.saveAndClose();

  return doc.getUrl();
}
