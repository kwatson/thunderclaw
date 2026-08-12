const elements = {
  origin: document.querySelector("#origin"),
  paragraphDefault: document.querySelector("#paragraph-default"),
  inspect: document.querySelector("#inspect"),
  capture: document.querySelector("#capture"),
  exact: document.querySelector("#exact"),
  inline: document.querySelector("#inline"),
  blocks: document.querySelector("#blocks"),
  listRewrite: document.querySelector("#list-rewrite"),
  listAdd: document.querySelector("#list-add"),
  listRemove: document.querySelector("#list-remove"),
  listReorder: document.querySelector("#list-reorder"),
  rollback: document.querySelector("#rollback"),
  undo: document.querySelector("#undo"),
  redo: document.querySelector("#redo"),
  verifyPre: document.querySelector("#verify-pre"),
  verifyPost: document.querySelector("#verify-post"),
  status: document.querySelector("#status"),
  report: document.querySelector("#report"),
  copy: document.querySelector("#copy"),
};

let tabId;
let captureId;
let capturePlacement;
let captureWholeListTargeted = false;
let captureSameKindListEligible = false;
let trialId;

function metadata(details) {
  return {
    recordedAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    composeOrigin: elements.origin.value,
    paragraphDefault: elements.paragraphDefault.value,
    editor: {
      isPlainText: details.isPlainText,
      deliveryFormat: typeof details.deliveryFormat === "string" ? details.deliveryFormat : "missing",
    },
  };
}

function render(operation, details, value) {
  elements.report.value = JSON.stringify({ operation, ...metadata(details), value }, null, 2);
  elements.status.dataset.error = "false";
  elements.status.textContent = `${operation} finished.`;
}

function showError(error) {
  elements.status.dataset.error = "true";
  elements.status.textContent = error instanceof Error ? error.message : String(error);
}

async function details() {
  return browser.compose.getComposeDetails(tabId);
}

async function send(type, extra = {}) {
  const response = await browser.tabs.sendMessage(tabId, { type: `rich-compose-r0.${type}`, ...extra });
  if (!response?.ok) throw new Error(response?.error || "The R0 compose script did not complete the operation.");
  return response.value;
}

function setTrialButtons() {
  elements.inline.disabled = !captureId || capturePlacement !== "inline";
  elements.blocks.disabled = !captureId || capturePlacement !== "blocks" || captureWholeListTargeted;
  const wholeListDisabled = !captureId || !captureWholeListTargeted || !captureSameKindListEligible;
  elements.listRewrite.disabled = wholeListDisabled;
  elements.listAdd.disabled = wholeListDisabled;
  elements.listRemove.disabled = wholeListDisabled;
  elements.listReorder.disabled = wholeListDisabled;
  elements.rollback.disabled = !captureId || capturePlacement !== "inline";
  elements.undo.disabled = !trialId;
  elements.redo.disabled = !trialId;
  elements.verifyPre.disabled = !trialId;
  elements.verifyPost.disabled = !trialId;
}

async function run(operation, callback) {
  try {
    const composeDetails = await details();
    const value = await callback(composeDetails);
    render(operation, composeDetails, value);
  } catch (error) {
    showError(error);
  }
}

elements.inspect.addEventListener("click", () => void run("inspect editor DOM", () => send("inspect", { exact: false })));
elements.exact.addEventListener("click", () => void run("export exact DOM", () => send("inspect", { exact: true })));
elements.capture.addEventListener("click", () => void run("capture selection", async () => {
  const value = await send("capture");
  captureId = value.captureId;
  capturePlacement = value.classification.placement;
  captureWholeListTargeted = value.wholeListTargeted === true;
  captureSameKindListEligible = value.sameKindListEligible === true;
  setTrialButtons();
  return value;
}));

async function apply(preset, induceFailure, composeDetails) {
  const value = await send("apply", {
    captureId,
    preset,
    induceFailure,
    editorMode: {
      isPlainText: composeDetails.isPlainText,
      deliveryFormat: typeof composeDetails.deliveryFormat === "string" ? composeDetails.deliveryFormat : "missing",
    },
  });
  captureId = undefined;
  capturePlacement = undefined;
  captureWholeListTargeted = false;
  captureSameKindListEligible = false;
  trialId = value.trialId;
  setTrialButtons();
  return value;
}

elements.inline.addEventListener("click", () => void run("apply inline fixture", (composeDetails) => apply("inline", false, composeDetails)));
elements.blocks.addEventListener("click", () => void run("unsupported mixed block diagnostic", (composeDetails) => apply("blocks", false, composeDetails)));
elements.listRewrite.addEventListener("click", () => void run("rewrite whole list", (composeDetails) => apply("same-kind-list-rewrite", false, composeDetails)));
elements.listAdd.addEventListener("click", () => void run("add whole-list items", (composeDetails) => apply("same-kind-list-add", false, composeDetails)));
elements.listRemove.addEventListener("click", () => void run("remove whole-list items", (composeDetails) => apply("same-kind-list-remove", false, composeDetails)));
elements.listReorder.addEventListener("click", () => void run("reorder whole list", (composeDetails) => apply("same-kind-list-reorder", false, composeDetails)));
elements.rollback.addEventListener("click", () => void run("induced rollback", (composeDetails) => apply("inline", true, composeDetails)));
elements.undo.addEventListener("click", () => void run("ThunderClaw Undo", () => send("undo", { trialId })));
elements.redo.addEventListener("click", () => void run("ThunderClaw Redo", () => send("redo", { trialId })));
elements.verifyPre.addEventListener("click", () => void run("verify Ctrl+Z result", () => send("verify", { trialId, expected: "pre" })));
elements.verifyPost.addEventListener("click", () => void run("verify Ctrl+Y result", () => send("verify", { trialId, expected: "post" })));
elements.copy.addEventListener("click", () => void navigator.clipboard.writeText(elements.report.value).then(
  () => { elements.status.textContent = "Report copied."; },
  showError,
));

async function initialize() {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tabs[0]?.id) throw new Error("Open this action from a Thunderbird compose window.");
  tabId = tabs[0].id;
  const state = await send("state");
  captureId = state.latestCaptureId;
  capturePlacement = state.latestCapturePlacement;
  captureWholeListTargeted = state.latestCaptureWholeListTargeted === true;
  captureSameKindListEligible = state.latestCaptureSameKindListEligible === true;
  trialId = state.latestTrialId;
  setTrialButtons();
  render("initialize", await details(), state);
}

void initialize().catch(showError);
