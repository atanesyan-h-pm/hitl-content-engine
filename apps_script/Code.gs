/**
 * ELITE B2B SAAS CONTENT PIPELINE (Cloud Run Architecture)
 * Apps Script -> Cloud Run HTTP (main.py) -> Google Docs
 */

// ==========================================
// 1. CONFIGURATION & PROMPT IDs
// ==========================================
const CLOUD_RUN_URL = 'https://crewai-blog-webhook-782827619242.europe-west1.run.app';

const PROMPT_DOC_IDS = {
  RESEARCHER: '1myPY_C7bTOf-pBh6UZT5OEYfFX1Jgrn2-PpDt1JIk00',
  PLANNER: '1OSwiDLVLPlWi-t8Noz81Ov0IcPWVjFU2n6IJW77hpYo',
  WRITER: '1LFO94HFl2aJWxK6qBgpXgnCRsbtPlJlqLrLQi21y4yI'
};

// ==========================================
// 2. SPREADSHEET MENU & TRIGGER FUNCTIONS
// ==========================================

/**
 * Creates custom menu in Google Sheets on document open.
 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Content Pipeline')
    .addItem('Run Pipeline for Selected Row', 'runForSelectedRow')
    .addItem('Run Pipeline for All Pending Rows', 'runForActiveSheet')
    .addToUi();
}

/**
 * Runs the content pipeline for the currently selected row in the spreadsheet.
 */
function runForSelectedRow() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  const row = sheet.getActiveCell().getRow();
  
  if (row < 2) {
    SpreadsheetApp.getUi().alert('Please select a data row (row 2 or below).');
    return;
  }
  
  const topic = sheet.getRange(row, 1).getValue();
  const coreFocus = sheet.getRange(row, 2).getValue();
  const description = sheet.getRange(row, 3).getValue();
  
  if (!topic) {
    SpreadsheetApp.getUi().alert('Selected row has no Topic in Column A.');
    return;
  }
  
  SpreadsheetApp.getActiveSpreadsheet().toast('Processing row ' + row + ': ' + topic, 'Content Pipeline', 5);
  
  const result = runContentPipeline(topic, coreFocus, description);
  sheet.getRange(row, 4).setValue(result.docUrl);
  
  SpreadsheetApp.getUi().alert('Pipeline completed successfully!\nOutput Doc: ' + result.docUrl);
}

/**
 * Runs the content pipeline for all rows in the sheet that do not yet have an output link.
 */
function runForActiveSheet() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  const lastRow = sheet.getLastRow();
  
  if (lastRow < 2) {
    SpreadsheetApp.getUi().alert('No data rows found in the active sheet.');
    return;
  }
  
  let processedCount = 0;
  for (let row = 2; row <= lastRow; row++) {
    const topic = sheet.getRange(row, 1).getValue();
    const coreFocus = sheet.getRange(row, 2).getValue();
    const description = sheet.getRange(row, 3).getValue();
    const existingLink = sheet.getRange(row, 4).getValue();
    
    if (topic && !existingLink) {
      SpreadsheetApp.getActiveSpreadsheet().toast('Processing row ' + row + '/' + lastRow, 'Content Pipeline', 5);
      const result = runContentPipeline(topic, coreFocus, description);
      sheet.getRange(row, 4).setValue(result.docUrl);
      processedCount++;
    }
  }
  
  SpreadsheetApp.getUi().alert('Batch run complete. Processed ' + processedCount + ' row(s).');
}

// ==========================================
// 3. MAIN PIPELINE ORCHESTRATOR
// ==========================================
// ⚠️ Transmits Google Doc prompts and sheet data to an external Cloud Run endpoint - verify the recipient URL is trusted.
function runContentPipeline(topic, coreFocus, contextDescription) {
  try {
    Logger.log("Fetching system prompts from Google Docs...");
    const researchPrompt = getDocText(PROMPT_DOC_IDS.RESEARCHER);
    const planPrompt = getDocText(PROMPT_DOC_IDS.PLANNER);
    const writerPrompt = getDocText(PROMPT_DOC_IDS.WRITER);

    Logger.log("Calling Cloud Run endpoint...");
    const articleText = callCloudRunApi(topic, coreFocus, contextDescription, researchPrompt, planPrompt, writerPrompt);

    Logger.log("Pipeline complete. Saving output Google Doc...");
    const docUrl = saveToSameFolder(topic, articleText);

    return { article: articleText, docUrl: docUrl };

  } catch (error) {
    Logger.log("PIPELINE FAILED: " + error.message);
    throw error;
  }
}

// ==========================================
// 4. CLOUD RUN HTTP API CALL
// ==========================================
function callCloudRunApi(topic, coreFocus, description, researchPrompt, planPrompt, writerPrompt) {
  const payload = {
    "action": "draft",
    "topic": topic,
    "core_focus": coreFocus,
    "description": description,
    "research_prompt": researchPrompt,
    "plan_prompt": planPrompt,
    "writer_prompt": writerPrompt
  };

  const options = {
    "method": "post",
    "contentType": "application/json",
    "payload": JSON.stringify(payload),
    "muteHttpExceptions": true
  };

  const response = UrlFetchApp.fetch(CLOUD_RUN_URL, options);
  const responseCode = response.getResponseCode();
  const jsonText = response.getContentText();

  let json;
  try {
    json = JSON.parse(jsonText);
  } catch (e) {
    throw new Error("Invalid JSON response from Cloud Run (" + responseCode + "): " + jsonText);
  }

  if (responseCode !== 200 || json.status === "error") {
    const stage = json.failed_stage ? json.failed_stage : "Execution";
    const details = json.error_details ? json.error_details : jsonText;
    throw new Error("Cloud Run Error [" + stage + "]: " + details);
  }

  if (!json.article) {
    throw new Error("Cloud Run response missing 'article' payload.");
  }

  return json.article;
}

// ==========================================
// 5. UTILITY & DRIVE FUNCTIONS
// ==========================================

/**
 * Extracts text from a Google Doc by ID.
 */
function getDocText(docId) {
  const doc = DocumentApp.openById(docId);
  return doc.getBody().getText();
}

/**
 * Saves generated article to a new Google Doc created in the SAME folder as the active Spreadsheet.
 */
function saveToSameFolder(topic, article) {
  const safeTopic = topic.replace(/[^a-z0-9]/gi, '_').substring(0, 30);
  const docTitle = 'V2_Draft_' + safeTopic;
  const doc = DocumentApp.create(docTitle);
  const docFile = DriveApp.getFileById(doc.getId());

  const ssId = SpreadsheetApp.getActiveSpreadsheet().getId();
  const ssFile = DriveApp.getFileById(ssId);
  const parents = ssFile.getParents();

  if (parents.hasNext()) {
    const targetFolder = parents.next();
    docFile.moveTo(targetFolder);
  }

  const body = doc.getBody();
  body.appendParagraph("--- FINAL ARTICLE ---").setHeading(DocumentApp.ParagraphHeading.HEADING1);
  body.appendParagraph(article);

  Logger.log("Saved output document: " + doc.getUrl());
  return doc.getUrl();
}

/**
 * Test execution function.
 */
function testV2Pipeline() {
  const testTopic = "Context is King: Scale, Startups & Deep Tech";
  const testCoreFocus = "Explores how the PM role mutates based on the environment.";
  const testContext = "Target audience is experienced PMs. Keep tone analytical and contrarian.";
  
  runContentPipeline(testTopic, testCoreFocus, testContext);
}
