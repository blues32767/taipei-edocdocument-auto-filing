// /**
//  * 公文系統自動存查
//  * @author blues32767
//  * @version 3.2.0 (整合介面、修復狀態衝突與自動關閉分頁)
//  */

// 攔截「附件歸檔」彈出的新分頁，自動關閉
if (window.location.href.includes('AOSDD017F')) {
  console.log('【自動存查】偵測到附件歸檔分頁，準備自動關閉...');
  setTimeout(() => {
    window.close();
  }, 500);
  throw new Error('This is an attachment window, stopping main script execution.');
}

const CONFIG = {
  fileNumber: '03010101',
  caseNumber: '1',
  autoDisableTime: 10,
  waitTimeForCaseOptions: 2000
};

let autoEnabled = false;
let currentIframe = null;
let currentIframeUrl = '';
let autoDisableTimer = null;
let hasProcessedArchive = false;
let lastProcessedUrl = '';
let processingInProgress = false;
let documentProcessCount = 0;

function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['fileNumber', 'caseNumber'], function (result) {
      if (result.fileNumber) CONFIG.fileNumber = result.fileNumber;
      if (result.caseNumber) CONFIG.caseNumber = result.caseNumber;
      resolve();
    });
  });
}

function checkPageHasSaveButton(iframe) {
  try {
    if (!iframe) return false;
    const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
    const saveButton = findSaveButton(iframeDoc);
    return saveButton !== null;
  } catch (e) {
    console.error('檢查頁面支援時發生錯誤:', e);
    return false;
  }
}

async function initialize() {
  createStatusButton();
  await loadSettings();
  autoEnabled = false;
  chrome.storage.local.set({ autoEnabled: false });
  updateStatusButton(false);
  hasProcessedArchive = false;
  lastProcessedUrl = '';
  processingInProgress = false;
  documentProcessCount = 0;

  if (autoDisableTimer) {
    clearTimeout(autoDisableTimer);
    autoDisableTimer = null;
  }
  setTimeout(checkIframeAndAutomate, 1000);
}

chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
  if (request.toggleAuto) {
    const status = toggleAuto();
    sendResponse({ status: status });
  }
  else if (request.updateSettings) {
    if (request.fileNumber) CONFIG.fileNumber = request.fileNumber;
    if (request.caseNumber) CONFIG.caseNumber = request.caseNumber;
    sendResponse({ success: true, fileNumber: CONFIG.fileNumber, caseNumber: CONFIG.caseNumber });
  }
  else if (request.checkStatus) {
    sendResponse({ status: getAutoStatus() });
  }
  return true;
});

function checkIframeAndAutomate() {
  if (processingInProgress) return;

  const iframe = document.getElementById('dTreeContent');
  if (!iframe) return;

  currentIframe = iframe;
  try {
    currentIframeUrl = iframe.contentWindow.location.href;
    if (currentIframeUrl === lastProcessedUrl) return;

    if (autoEnabled) {
      if (/AOSDA006F_s02\.jsp/.test(currentIframeUrl)) {
        const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
        if (iframeDoc.readyState !== 'complete') {
          iframe.addEventListener('load', () => {
            processSaveButtonCheck(iframe);
          }, { once: true });
          return;
        }
        processSaveButtonCheck(iframe);
      } else if (currentIframeUrl.includes('AOSDA062F_s18.jsp')) {
        automateArchiveActions(iframe);
        lastProcessedUrl = currentIframeUrl;
      }
    }
  } catch (e) {
    console.error('Error accessing iframe URL:', e);
  }
}

function processSaveButtonCheck(iframe) {
  const hasButton = checkPageHasSaveButton(iframe);
  if (hasButton) {
    automateCheckActions(iframe);
    lastProcessedUrl = currentIframeUrl;
  } else {
    setTimeout(() => {
      const retryHasButton = checkPageHasSaveButton(iframe);
      if (retryHasButton) {
        automateCheckActions(iframe);
        lastProcessedUrl = currentIframeUrl;
      } else {
        showNotification('頁面不支援', '未找到存查按鈕，此頁面不支援自動存查功能');
        autoEnabled = false;
        chrome.storage.local.set({ autoEnabled: false });
        updateStatusButton(false);
        if (autoDisableTimer) {
          clearTimeout(autoDisableTimer);
          autoDisableTimer = null;
        }
      }
    }, 2000);
  }
}

function automateCheckActions(iframe) {
  processingInProgress = true;
  const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;

  if (iframeDoc.readyState === 'complete') {
    processDocumentList(iframeDoc);
  } else {
    iframe.addEventListener('load', () => {
      processDocumentList(iframeDoc);
    }, { once: true });
  }
}

function automateArchiveActions(iframe) {
  processingInProgress = true;
  const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;

  if (iframeDoc.readyState === 'complete') {
    processArchiveForm(iframeDoc);
  } else {
    iframe.addEventListener('load', () => {
      processArchiveForm(iframeDoc);
    }, { once: true });
  }
}

function findSaveButton(iframeDoc) {
  if (!iframeDoc || iframeDoc.readyState !== 'complete') return null;

  const commonIds = ['000011803', '000011703', '000011903', '000011603', 'subActionName'];
  for (const id of commonIds) {
    const button = iframeDoc.querySelector(`input[name="${id}"][value="存查"]`);
    if (button) return button;
  }

  const valueButton = iframeDoc.querySelector('input[value="存查"]');
  if (valueButton) return valueButton;

  const allInputs = iframeDoc.querySelectorAll('input[type="button"], input[type="submit"]');
  for (const input of allInputs) {
    if (input.value === "存查") return input;
  }

  const allElements = iframeDoc.querySelectorAll('*');
  for (const element of allElements) {
    if (element.textContent && element.textContent.includes("存查") &&
      (element.tagName === 'BUTTON' || element.tagName === 'INPUT' || element.onclick || element.getAttribute('onclick'))) {
      return element;
    }
  }

  const onclickInputs = iframeDoc.querySelectorAll('input[onclick]');
  for (const input of onclickInputs) {
    if (input.value === "存查" || input.textContent?.includes("存查")) {
      return input;
    }
  }
  return null;
}

function processDocumentList(iframeDoc) {
  const listContainer = iframeDoc.querySelector('#listContainer');
  if (!listContainer) {
    processingInProgress = false;
    return;
  }

  const checkboxes = iframeDoc.querySelectorAll('#listTBODY tr input[type="checkbox"][name="ids"]');

  if (checkboxes.length === 0) {
    autoEnabled = false;
    chrome.storage.local.set({ autoEnabled: false });
    updateStatusButton(false);
    showNotification('自動存查功能已停用', '無可存查的公文');
    processingInProgress = false;
    return;
  }

  let foundUnchecked = false;
  for (let i = 0; i < checkboxes.length; i++) {
    const checkbox = checkboxes[i];
    if (!checkbox.checked) {
      checkbox.checked = true;
      foundUnchecked = true;
      documentProcessCount++;

      const iCheckDiv = checkbox.parentElement;
      if (iCheckDiv && iCheckDiv.classList.contains('icheckbox_minimal-orange')) {
        iCheckDiv.classList.add('checked');
      }

      const saveButton = findSaveButton(iframeDoc);
      if (saveButton) {
        const clickEvent = new Event('click', { bubbles: true });
        saveButton.dispatchEvent(clickEvent);

        setTimeout(() => {
          processingInProgress = false;
          hasProcessedArchive = false;
          setTimeout(checkIframeAndAutomate, 1000);
        }, 5000);
      } else {
        showNotification('自動存查失敗', '無法找到存查按鈕，請手動操作');
        processingInProgress = false;
      }
      break;
    }
  }

  if (!foundUnchecked) {
    autoEnabled = false;
    chrome.storage.local.set({ autoEnabled: false });
    updateStatusButton(false);
    showNotification('自動存查功能已停用', '無可存查的公文');
    processingInProgress = false;
  }
}

function waitForElement(selector, iframeDoc, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const element = iframeDoc.querySelector(selector);
    if (element) return resolve(element);
    const startTime = Date.now();
    const interval = setInterval(() => {
      const el = iframeDoc.querySelector(selector);
      if (el) {
        clearInterval(interval);
        resolve(el);
      } else if (Date.now() - startTime > timeout) {
        clearInterval(interval);
        reject(new Error(`Timeout waiting for ${selector}`));
      }
    }, 100);
  });
}

async function processArchiveForm(iframeDoc) {
  try {
    const fileTypeSelect = await waitForElement('select[name="q_fsKindno"]', iframeDoc);
    if (fileTypeSelect) {
      fileTypeSelect.value = CONFIG.fileNumber;
      const changeEvent = new Event('change', { bubbles: true });
      fileTypeSelect.dispatchEvent(changeEvent);
    } else {
      showNotification('存檔失敗', '無法找到檔號選擇框');
      processingInProgress = false;
      return;
    }

    const caseNoSelect = await waitForElement('select[name="q_caseno"]', iframeDoc);
    if (caseNoSelect) {
      if (caseNoSelect.options.length > 1) {
        caseNoSelect.value = CONFIG.caseNumber;
        const caseChangeEvent = new Event('change', { bubbles: true });
        caseNoSelect.dispatchEvent(caseChangeEvent);

        const submitButton = await waitForElement('input[name="updateSubmit"][value="確定存檔"]', iframeDoc);
        if (submitButton) {
          try {
            let attachBtn = iframeDoc.querySelector('input[value*="附件歸檔"], button[value*="附件歸檔"]');
            if (!attachBtn) {
              const btns = iframeDoc.querySelectorAll('button');
              for (let b of btns) {
                if (b.textContent.includes('附件歸檔')) { attachBtn = b; break; }
              }
            }

            if (attachBtn) {
              attachBtn.click();
              await new Promise(resolve => setTimeout(resolve, 1500));
            }
          } catch (err) {
            console.error('點擊附件歸檔時發生錯誤:', err);
          }

          submitButton.click();
          setTimeout(() => {
            processingInProgress = false;
          }, 3000);
        } else {
          showNotification('存檔失敗', '無法找到確定存檔按鈕');
          processingInProgress = false;
        }
      } else {
        showNotification('存檔失敗', '案次號選項未載入');
        processingInProgress = false;
      }
    } else {
      showNotification('存檔失敗', '無法找到案次號選擇框');
      processingInProgress = false;
    }
  } catch (e) {
    showNotification('存檔失敗', `處理發生錯誤: ${e.message}`);
    processingInProgress = false;
  }
}

function setAutoDisableTimer() {
  if (autoDisableTimer) clearTimeout(autoDisableTimer);
  autoDisableTimer = setTimeout(() => {
    if (autoEnabled) {
      autoEnabled = false;
      chrome.storage.local.set({ autoEnabled: false });
      updateStatusButton(false);
      showNotification('自動存查功能已自動關閉', `已經過${CONFIG.autoDisableTime}分鐘，功能已關閉。`);
    }
  }, CONFIG.autoDisableTime * 60 * 1000);
}

function showNotification(title, message) {
  const notification = document.createElement('div');
  notification.className = 'auto-disable-notification';
  notification.innerHTML = `<div class="notification-title">${title}</div><div class="notification-message">${message}</div>`;

  const style = document.createElement('style');
  style.textContent = `
    .auto-disable-notification {
      position: fixed; bottom: 20px; right: 20px; background-color: #333; color: white;
      padding: 15px; border-radius: 5px; box-shadow: 0 3px 10px rgba(0,0,0,0.2);
      z-index: 10000; max-width: 300px; animation: fadeInOut 8s forwards;
    }
    .notification-title { font-weight: bold; margin-bottom: 5px; color: #ff5252; }
    .notification-message { font-size: 14px; }
    @keyframes fadeInOut {
      0% { opacity: 0; transform: translateY(20px); }
      10% { opacity: 1; transform: translateY(0); }
      80% { opacity: 1; transform: translateY(0); }
      100% { opacity: 0; transform: translateY(-20px); }
    }
  `;
  document.head.appendChild(style);
  document.body.appendChild(notification);
  setTimeout(() => { notification.remove(); }, 8000);
}

function createStatusButton() {
  if (document.getElementById('autoStatusWidget')) return;

  const widgetContainer = document.createElement('div');
  widgetContainer.id = 'autoStatusWidget';
  widgetContainer.className = 'collapsed';
  widgetContainer.style.display = 'none';

  widgetContainer.innerHTML = `
    <div class="widget-main-bar">
      <div class="status-indicator">
        <div class="status-dot"></div>
        <span class="status-text">自動存查: 關閉</span>
      </div>
      <div class="quick-actions">
        <button id="btnStart" class="quick-btn btn-start" title="開始執行自動存查">▶ 開始執行</button>
        <button id="btnStop" class="quick-btn btn-stop" style="display:none;" title="停止自動存查">⏹ 停止執行</button>
        <button id="btnSettings" class="quick-btn btn-settings" title="展開/收合設定">⚙️ 設定</button>
      </div>
    </div>
    <div class="widget-settings-panel">
      <div class="settings-grid-1x2">
        <div class="input-group">
          <label>檔號</label>
          <input type="text" id="widgetFileNumber" value="${CONFIG.fileNumber || ''}" placeholder="例: 03010101">
        </div>
        <div class="input-group">
          <label>案次號</label>
          <input type="text" id="widgetCaseNumber" value="${CONFIG.caseNumber || ''}" placeholder="例: 1">
        </div>
      </div>
      <button id="widgetSaveBtn" class="btn-save">💾 儲存設定</button>
      <div class="counter-badge">已處理: <span id="widgetCounter">0</span> 件</div>
    </div>
  `;

  const styles = document.createElement('style');
  styles.textContent = `
    #autoStatusWidget {
      position: fixed; top: 15px; right: 15px; width: 280px;
      background-color: rgba(251, 251, 251, 0.95); border-radius: 6px;
      box-shadow: 0 2px 6px rgba(0, 0, 0, 0.1); border: 1px solid #dce1e5;
      font-family: 'Microsoft JhengHei', Arial, sans-serif; z-index: 9999;
      opacity: 0.9; transition: border-color 0.3s;
    }
    #autoStatusWidget:hover { opacity: 1; box-shadow: 0 4px 10px rgba(0, 0, 0, 0.15); }
    #autoStatusWidget.active-widget { border-color: rgba(101, 222, 199, 0.8); background-color: #ffffff; }
    .widget-main-bar { padding: 10px 12px; display: flex; flex-direction: column; gap: 10px; border-radius: 6px; background-color: rgba(54, 66, 80, 0.05); }
    .active-widget .widget-main-bar { background-color: rgba(101, 222, 199, 0.15); }
    .status-indicator { display: flex; align-items: center; font-size: 14px; font-weight: bold; color: #364250; }
    .status-dot { width: 10px; height: 10px; border-radius: 50%; background-color: #f0524b; margin-right: 8px; }
    .active-widget .status-dot { background-color: #2eaf7d; box-shadow: 0 0 4px rgba(46, 175, 125, 0.4); }
    .active-widget .status-text { color: #1a6e4d; }
    .quick-actions { display: flex; gap: 6px; justify-content: space-between; }
    .quick-btn { flex: 1; padding: 6px 8px; border: none; border-radius: 4px; font-size: 13px; font-weight: bold; cursor: pointer; transition: background-color 0.2s; }
    .btn-start { background-color: #38b28f; color: white; }
    .btn-start:hover { background-color: #2b8a6e; }
    .btn-stop { background-color: #f0524b; color: white; }
    .btn-stop:hover { background-color: #d63d36; }
    .btn-settings { background-color: #e9ecef; color: #495057; border: 1px solid #ced4da; }
    .btn-settings:hover { background-color: #dee2e6; }
    .btn-settings.active { background-color: #ced4da; }
    .widget-settings-panel { max-height: 200px; opacity: 1; padding: 12px; overflow: hidden; border-top: 1px solid #eee; transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1); }
    .collapsed .widget-settings-panel { max-height: 0; opacity: 0; padding: 0 12px; border-top: 0px solid transparent; }
    .settings-grid-1x2 { display: grid; grid-template-columns: 1fr; grid-template-rows: auto auto; gap: 8px; margin-bottom: 10px; }
    .input-group { display: flex; align-items: center; }
    .input-group label { width: 50px; font-size: 13px; color: #555; font-weight: 600; }
    .input-group input { flex: 1; padding: 6px; font-size: 13px; border: 1px solid #ccc; border-radius: 3px; }
    .btn-save { width: 100%; padding: 8px; border: none; border-radius: 4px; font-size: 13px; font-weight: bold; cursor: pointer; background-color: #e9ecef; color: #495057; margin-bottom: 8px; }
    .btn-save:hover { background-color: #dee2e6; }
    .counter-badge { text-align: right; font-size: 12px; color: #888; }
    #widgetCounter { font-weight: bold; color: #1a6e4d; font-size: 14px; }
  `;
  document.head.appendChild(styles);
  document.body.appendChild(widgetContainer);

  document.getElementById('btnStart').addEventListener('click', () => { if (!autoEnabled) toggleAuto(); });
  document.getElementById('btnStop').addEventListener('click', () => { if (autoEnabled) toggleAuto(); });
  document.getElementById('btnSettings').addEventListener('click', (e) => {
    widgetContainer.classList.toggle('collapsed');
    e.target.classList.toggle('active');
  });

  document.getElementById('widgetSaveBtn').addEventListener('click', () => {
    const newFile = document.getElementById('widgetFileNumber').value.trim();
    const newCase = document.getElementById('widgetCaseNumber').value.trim();
    if (newFile && newCase) {
      CONFIG.fileNumber = newFile;
      CONFIG.caseNumber = newCase;
      chrome.storage.local.set({ fileNumber: newFile, caseNumber: newCase });
      const btn = document.getElementById('widgetSaveBtn');
      btn.textContent = '✅ 設定已儲存';
      btn.style.backgroundColor = '#d4edda';
      btn.style.color = '#155724';
      setTimeout(() => {
        btn.textContent = '💾 儲存設定';
        btn.style.backgroundColor = '#e9ecef';
        btn.style.color = '#495057';
      }, 2000);
    } else {
      alert('檔號與案次號請勿留白！');
    }
  });
}

function updateStatusButton(isActive) {
  const widget = document.getElementById('autoStatusWidget');
  if (!widget) return;

  const statusText = widget.querySelector('.status-text');
  const btnStart = document.getElementById('btnStart');
  const btnStop = document.getElementById('btnStop');
  const counter = document.getElementById('widgetCounter');

  if (isActive) {
    widget.classList.add('active-widget');
    statusText.textContent = '自動存查: 執行中';
    btnStart.style.display = 'none';
    btnStop.style.display = 'block';
  } else {
    widget.classList.remove('active-widget');
    statusText.textContent = '自動存查: 關閉';
    btnStart.style.display = 'block';
    btnStop.style.display = 'none';
  }
  if (counter) counter.textContent = documentProcessCount.toString();
}

function updateWidgetVisibility() {
  const widget = document.getElementById('autoStatusWidget');
  if (!widget) return;

  const pathnameEl = document.getElementById('pathname');
  const iframe = document.getElementById('dTreeContent');

  let isPendingClose = false;
  if (pathnameEl && pathnameEl.innerText.includes('待結案')) {
    isPendingClose = true;
  }

  let hasSaveBtn = false;
  if (iframe) {
    hasSaveBtn = checkPageHasSaveButton(iframe);
  }

  if (isPendingClose || hasSaveBtn) {
    widget.style.display = 'block';
  } else {
    widget.style.display = 'none';
    if (autoEnabled) {
      autoEnabled = false;
      chrome.storage.local.set({ autoEnabled: false });
      updateStatusButton(false);
    }
  }
}

function toggleAuto() {
  if (!autoEnabled) {
    const iframe = document.getElementById('dTreeContent');
    if (iframe && /AOSDA006F_s02\.jsp/.test(currentIframeUrl)) {
      const hasButton = checkPageHasSaveButton(iframe);
      if (!hasButton) {
        showNotification('頁面不支援', '未找到存查按鈕，此頁面不支援自動存查功能');
        return false;
      }
    }
  }

  autoEnabled = !autoEnabled;
  chrome.storage.local.set({ autoEnabled: autoEnabled });
  updateStatusButton(autoEnabled);

  if (autoEnabled) {
    hasProcessedArchive = false;
    lastProcessedUrl = '';
    processingInProgress = false;
    documentProcessCount = 0;
    checkIframeAndAutomate();
    setAutoDisableTimer();
  } else {
    if (autoDisableTimer) {
      clearTimeout(autoDisableTimer);
      autoDisableTimer = null;
    }
  }
  return autoEnabled;
}

function getAutoStatus() {
  return autoEnabled;
}

function initialize() {
  createStatusButton();
  loadSettings();
  autoEnabled = false;
  chrome.storage.local.set({ autoEnabled: false });
  updateStatusButton(false);
  hasProcessedArchive = false;
  lastProcessedUrl = '';
  processingInProgress = false;
  documentProcessCount = 0;
  setTimeout(checkIframeAndAutomate, 1000);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initialize);
} else {
  initialize();
}

document.addEventListener('DOMContentLoaded', () => {
  const iframe = document.getElementById('dTreeContent');
  if (iframe) {
    iframe.addEventListener('load', () => {
      if (autoEnabled) {
        setTimeout(() => {
          if (!processingInProgress) checkIframeAndAutomate();
        }, 1000);
      }
    });
  }
});

setInterval(() => {
  updateWidgetVisibility();
  if (autoEnabled && !processingInProgress) {
    const iframe = document.getElementById('dTreeContent');
    if (iframe && iframe.contentWindow.location.href !== lastProcessedUrl) {
      checkIframeAndAutomate();
    }
  }
}, 3000);

const observer = new MutationObserver((mutations) => {
  updateWidgetVisibility();
  if (autoEnabled && !processingInProgress) {
    for (const mutation of mutations) {
      if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
        setTimeout(checkIframeAndAutomate, 500);
        break;
      }
    }
  }
});

observer.observe(document.body, { childList: true, subtree: true });
