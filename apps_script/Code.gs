/**
 * ELITE B2B SAAS CONTENT PIPELINE (V2)
 * Agent A (Researcher) -> Agent B (Planner) -> Agent C (Writer)
 */

// ==========================================
// 1. CONFIGURATION & PROMPT IDs (V2)
// ==========================================
const API_KEY = 'YOUR_GEMINI_OR_OPENAI_API_KEY'; // Replace with your actual API key

const PROMPT_DOC_IDS = {
  RESEARCHER: '1myPY_C7bTOf-pBh6UZT5OEYfFX1Jgrn2-PpDt1JIk00',
  PLANNER: '1OSwiDLVLPlWi-t8Noz81Ov0IcPWVjFU2n6IJW77hpYo',
  WRITER: '1LFO94HFl2aJWxK6qBgpXgnCRsbtPlJlqLrLQi21y4yI'
};

// ==========================================
// 2. MAIN PIPELINE ORCHESTRATOR
// ==========================================
function runContentPipeline(topic, coreFocus, contextDescription) {
  try {
    Logger.log("Starting V2 Pipeline...");

    // Step 0: Load System Prompts from Google Docs
    const researcherSystemPrompt = getDocText(PROMPT_DOC_IDS.RESEARCHER);
    const plannerSystemPrompt = getDocText(PROMPT_DOC_IDS.PLANNER);
    const writerSystemPrompt = getDocText(PROMPT_DOC_IDS.WRITER);

    // ---------------------------------------------------------
    // AGENT A: RESEARCHER
    // ---------------------------------------------------------
    Logger.log("Running Agent A: Researcher...");
    const researcherInput = `
<topic>${topic}</topic>
<core_focus>${coreFocus}</core_focus>
<description>${contextDescription}</description>
    `.trim();
    
    const researchDossier = callAI(researcherSystemPrompt, researcherInput);
    checkForInputError(researchDossier, "Researcher (Agent A)");

    // ---------------------------------------------------------
    // AGENT B: PLANNER
    // ---------------------------------------------------------
    Logger.log("Running Agent B: Planner...");
    const plannerInput = `
<topic>${topic}</topic>
<core_focus>${coreFocus}</core_focus>
<description>${contextDescription}</description>

<research_dossier>
${researchDossier}
</research_dossier>
    `.trim();

    const editorialBlueprint = callAI(plannerSystemPrompt, plannerInput);
    checkForInputError(editorialBlueprint, "Planner (Agent B)");

    // ---------------------------------------------------------
    // AGENT C: WRITER
    // ---------------------------------------------------------
    Logger.log("Running Agent C: Writer...");
    const writerInput = `
<topic>${topic}</topic>
<core_focus>${coreFocus}</core_focus>
<description>${contextDescription}</description>

<research_dossier>
${researchDossier}
</research_dossier>

<editorial_blueprint>
${editorialBlueprint}
</editorial_blueprint>
    `.trim();

    let rawWriterOutput = callAI(writerSystemPrompt, writerInput);
    checkForInputError(rawWriterOutput, "Writer (Agent C)");

    // Clean the Writer's output (Strip the <scratchpad>)
    const finalArticle = extractFinalArticle(rawWriterOutput);

    // ---------------------------------------------------------
    // FINISH: Output the result
    // ---------------------------------------------------------
    Logger.log("Pipeline Complete! Saving to Document...");
    saveToNewDocument(topic, finalArticle, researchDossier, editorialBlueprint);
    
    return finalArticle;

  } catch (error) {
    Logger.log("PIPELINE FAILED: " + error.message);
    throw error;
  }
}

// ==========================================
// 3. UTILITY & PARSING FUNCTIONS
// ==========================================

/**
 * Checks if the agent aborted due to missing/bad inputs.
 */
function checkForInputError(output, agentName) {
  if (output.trim().startsWith("INPUT ERROR:")) {
    throw new Error(`Pipeline halted by ${agentName}. Reason: ${output.trim()}`);
  }
}

/**
 * Removes the <scratchpad> reasoning from the Writer's output to deliver the clean article.
 */
function extractFinalArticle(writerOutput) {
  const scratchpadEndTag = "</scratchpad>";
  if (writerOutput.includes(scratchpadEndTag)) {
    // Splits at the end tag and returns everything after it, trimmed of whitespace
    return writerOutput.split(scratchpadEndTag)[1].trim();
  }
  // Fallback if the AI didn't use the scratchpad tag
  return writerOutput.trim();
}

/**
 * Extracts text from a Google Doc by ID.
 */
function getDocText(docId) {
  const doc = DocumentApp.openById(docId);
  return doc.getBody().getText();
}

/**
 * Saves the final output (and optionally the intermediate steps) to a new Google Doc.
 */
function saveToNewDocument(topic, article, dossier, blueprint) {
  const safeTopic = topic.replace(/[^a-z0-9]/gi, '_').substring(0, 30);
  const doc = DocumentApp.create(`V2_Draft_${safeTopic}`);
  const body = doc.getBody();
  
  body.appendParagraph("--- FINAL ARTICLE ---").setHeading(DocumentApp.ParagraphHeading.HEADING1);
  body.appendParagraph(article);
  
  // Optional: Append Dossier and Blueprint at the bottom for review
  body.appendPageBreak();
  body.appendParagraph("--- EDITORIAL BLUEPRINT (AGENT B) ---").setHeading(DocumentApp.ParagraphHeading.HEADING1);
  body.appendParagraph(blueprint);
  
  body.appendPageBreak();
  body.appendParagraph("--- RESEARCH DOSSIER (AGENT A) ---").setHeading(DocumentApp.ParagraphHeading.HEADING1);
  body.appendParagraph(dossier);
  
  Logger.log("Saved new document: " + doc.getUrl());
  return doc.getUrl();
}

// ==========================================
// 4. API CALL FUNCTION (Adjust for Gemini/OpenAI)
// ==========================================

/**
 * Standard API call wrapper. 
 * Below is a template for the Gemini API. If you use OpenAI (ChatGPT), 
 * update the endpoint and payload structure accordingly.
 */
function callAI(systemInstruction, userPrompt) {
  // Example using Gemini 1.5 Pro
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key=${API_KEY}`;
  
  const payload = {
    "system_instruction": {
      "parts": [{ "text": systemInstruction }]
    },
    "contents": [
      {
        "role": "user",
        "parts": [{ "text": userPrompt }]
      }
    ],
    "generationConfig": {
      "temperature": 0.4 // Keeps output analytical and strictly aligned to instructions
    }
  };
  
  const options = {
    "method": "post",
    "contentType": "application/json",
    "payload": JSON.stringify(payload),
    "muteHttpExceptions": true
  };
  
  const response = UrlFetchApp.fetch(url, options);
  const json = JSON.parse(response.getContentText());
  
  if (json.error) {
    throw new Error("API Error: " + json.error.message);
  }
  
  // Extract the text from Gemini response
  return json.candidates[0].content.parts[0].text;
}

// ==========================================
// 5. TRIGGER FUNCTION (To run from Editor)
// ==========================================
function testV2Pipeline() {
  const testTopic = "Context is King: Scale, Startups & Deep Tech";
  const testCoreFocus = "Explores how the PM role mutates based on the environment. Contrasts the 0-to-1 PM in a startup with the in-scale enterprise PM, and dives into unique constraints of niche sectors.";
  const testContext = "Target audience is experienced PMs. Keep tone analytical and contrarian.";
  
  runContentPipeline(testTopic, testCoreFocus, testContext);
}
