
// /**
//  * 公文系統自動存查
//  * @author blues32767
//  * @version 2.1.0
//  * @created taiwan 2025/03/20
//  * @github https://github.com/blues32767
//   */


// 使用者設定區 - 方便修改
const CONFIG = {
  fileNumber: '03010101', // 檔號 (例如: '03010101'-綜合業務(3年))
  caseNumber: '1',        // 案次號 (例如: '1'-綜合業務(3))
  autoDisableTime: 10,    // 自動關閉時間 (分鐘)
  waitTimeForCaseOptions: 2000 // 等待案次號選項加載的時間 (毫秒)
};

// 全局變數
let autoEnabled = false; // 預設為關閉狀態
let currentIframe = null;
let currentIframeUrl = '';
let autoDisableTimer = null; // 用於自動關閉的計時器
let hasProcessedArchive = false; // 標記是否已處理過存檔頁面
let lastProcessedUrl = ''; // 記錄上次處理的URL
let processingInProgress = false; // 標記是否正在處理中
let documentProcessCount = 0; // 記錄已處理的文件數量

// 初始化時從 storage 讀取設定
function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['fileNumber', 'caseNumber'], function(result) {
      if (result.fileNumber) CONFIG.fileNumber = result.fileNumber;
      if (result.caseNumber) CONFIG.caseNumber = result.caseNumber;
      console.log('已載入設定 - 檔號:', CONFIG.fileNumber, '案次號:', CONFIG.caseNumber);
      resolve();
    });
  });
}

// 檢查頁面是否支援自動存查 (通過檢查是否存在「存查」按鈕)
function checkPageHasSaveButton(iframe) {
  try {
    if (!iframe) return false;
    
    const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
    
    // 使用現有的 findSaveButton 函數來檢查是否存在存查按鈕
    const saveButton = findSaveButton(iframeDoc);
    
    // 如果找到按鈕，則頁面支援自動存查
    return saveButton !== null;
  } catch (e) {
    console.error('檢查頁面支援時發生錯誤:', e);
    return false;
  }
}

// 修改初始化函數
async function initialize() {
  createStatusButton();
  
  // 等待設定載入完成
  await loadSettings();
  
  // 強制設置為關閉狀態，不管 storage 中的值
  autoEnabled = false;
  chrome.storage.local.set({autoEnabled: false});
  updateStatusButton(false);
  
  // 重置變數
  hasProcessedArchive = false;
  lastProcessedUrl = '';
  processingInProgress = false;
  documentProcessCount = 0;
  
  // 如果有計時器，清除它
  if (autoDisableTimer) {
    clearTimeout(autoDisableTimer);
    autoDisableTimer = null;
  }
  
  // 初始化時檢查 iframe
  setTimeout(checkIframeAndAutomate, 1000);
}

// 監聽來自擴充套件popup的消息
chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
  if (request.toggleAuto) {
      const status = toggleAuto();
      sendResponse({status: status});
  } 
  else if (request.updateSettings) {
      if (request.fileNumber) CONFIG.fileNumber = request.fileNumber;
      if (request.caseNumber) CONFIG.caseNumber = request.caseNumber;
      console.log('設定已更新 - 檔號:', CONFIG.fileNumber, '案次號:', CONFIG.caseNumber);
      updateSettingsDisplay(); // 更新顯示
      sendResponse({success: true, fileNumber: CONFIG.fileNumber, caseNumber: CONFIG.caseNumber});
  }
  else if (request.checkStatus) {
      sendResponse({status: getAutoStatus()});
  }
  return true;
});

  
// 獲取 iframe URL 並執行相應的自動化操作
function checkIframeAndAutomate() {
  if (processingInProgress) {
    console.log('Processing in progress, skipping check');
    return;
  }

  const iframe = document.getElementById('dTreeContent');
  if (!iframe) {
    console.log('Iframe with id "dTreeContent" not found');
    return;
  }

  currentIframe = iframe;
  try {
    currentIframeUrl = iframe.contentWindow.location.href;
    if (currentIframeUrl === lastProcessedUrl) {
      console.log('URL unchanged, skipping');
      return;
    }
    console.log('Current iframe URL:', currentIframeUrl);
    console.log('Iframe src attribute:', iframe.src);

    if (autoEnabled) {
      if (/AOSDA006F_s02\.jsp/.test(currentIframeUrl)) {
        const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
        if (iframeDoc.readyState !== 'complete') {
          console.log('Iframe not fully loaded, waiting...');
          iframe.addEventListener('load', () => {
            console.log('Iframe loaded, checking save button');
            processSaveButtonCheck(iframe);
          }, { once: true });
          return;
        }
        processSaveButtonCheck(iframe);
      } else if (currentIframeUrl.includes('AOSDA062F_s18.jsp')) { // 移除 !hasProcessedArchive 條件
        console.log('On archive page, processing archive form');
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
    console.log('找到存查按鈕，頁面支援自動存查');
    automateCheckActions(iframe);
    lastProcessedUrl = currentIframeUrl;
  } else {
    // 如果首次找不到，延遲重試一次
    console.log('未找到存查按鈕，延遲 2 秒後重試');
    setTimeout(() => {
      const retryHasButton = checkPageHasSaveButton(iframe);
      if (retryHasButton) {
        console.log('重試後找到存查按鈕，繼續處理');
        automateCheckActions(iframe);
        lastProcessedUrl = currentIframeUrl;
      } else {
        console.log('重試後仍未找到存查按鈕，此頁面不支援自動存查');
        showNotification('頁面不支援', '未找到存查按鈕，此頁面不支援自動存查功能');
        autoEnabled = false;
        chrome.storage.local.set({ autoEnabled: false });
        updateStatusButton(false);
        if (autoDisableTimer) {
          clearTimeout(autoDisableTimer);
          autoDisableTimer = null;
        }
      }
    }, 2000); // 延遲 2 秒後重試
  }
}




// 存查頁面的自動化操作
function automateCheckActions(iframe) {
  processingInProgress = true;
  const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;

  // 等待 iframe 內容完全加載
  if (iframeDoc.readyState === 'complete') {
    console.log('Iframe ready, automating check actions');
    processDocumentList(iframeDoc);
  } else {
    iframe.addEventListener('load', () => {
      console.log('Iframe loaded, automating check actions');
      processDocumentList(iframeDoc);
    }, { once: true }); // 確保事件只觸發一次
  }
}

// 存檔頁面的自動化操作
function automateArchiveActions(iframe) {
  processingInProgress = true;
  const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
  
  if (iframeDoc.readyState === 'complete') {
    console.log('Iframe ready, automating archive actions');
    processArchiveForm(iframeDoc);
    // 不設置 hasProcessedArchive = true，讓每次進入都執行
  } else {
    iframe.addEventListener('load', () => {
      console.log('Iframe loaded, automating archive actions');
      processArchiveForm(iframeDoc);
    }, { once: true });
  }
}

// 嘗試找到存查按鈕的函數
function findSaveButton(iframeDoc) {
  // 等待 iframeDoc 準備好
  if (!iframeDoc || iframeDoc.readyState !== 'complete') {
    console.log('Iframe document not ready yet');
    return null;
  }

  // 方法 4: 優先嘗試常見的 ID 或 name 模式，並將 "000011803" 設為最高優先級
  const commonIds = ['000011803', '000011703', '000011903', '000011603', 'subActionName'];
  for (const id of commonIds) {
    const button = iframeDoc.querySelector(`input[name="${id}"][value="存查"]`);
    if (button) {
      console.log(`找到存查按鈕 (使用常見 ID: ${id}), name:`, button.name || '無 name 屬性');
      return button; // 找到後立即返回，優先級最高的是 "000011803"
    }
  }

  // 方法 1: 使用 value 屬性查找
  const valueButton = iframeDoc.querySelector('input[value="存查"]');
  if (valueButton) {
    console.log('找到存查按鈕 (透過 value 屬性), name:', valueButton.name || '無 name 屬性');
    return valueButton;
  }

  // 方法 2: 查找包含 "存查" 文字的按鈕
  const allInputs = iframeDoc.querySelectorAll('input[type="button"], input[type="submit"]');
  for (const input of allInputs) {
    if (input.value === "存查") {
      console.log('找到存查按鈕 (透過按鈕文字), name:', input.name || '無 name 屬性');
      return input;
    }
  }

  // 方法 3: 查找包含 "存查" 文字的任何元素
  const allElements = iframeDoc.querySelectorAll('*');
  for (const element of allElements) {
    if (
      element.textContent && 
      element.textContent.includes("存查") && 
      (element.tagName === 'BUTTON' || 
       element.tagName === 'INPUT' || 
       element.onclick || 
       element.getAttribute('onclick'))
    ) {
      console.log('找到存查按鈕 (透過元素文字和標籤), name:', element.name || '無 name 屬性');
      return element;
    }
  }

  // 方法 5: 檢查所有帶 onclick 屬性的 input
  const onclickInputs = iframeDoc.querySelectorAll('input[onclick]');
  for (const input of onclickInputs) {
    if (input.value === "存查" || input.textContent?.includes("存查")) {
      console.log('找到存查按鈕 (透過 onclick 屬性), name:', input.name || '無 name 屬性');
      return input;
    }
  }

  console.log('未找到存查按鈕，列出部分 DOM 資訊以供診斷');
  console.log('Inputs with value:', iframeDoc.querySelectorAll('input[value]'));
  console.log('Buttons:', iframeDoc.querySelectorAll('button, input[type="button"], input[type="submit"]'));
  return null;
}
// 處理存查頁面的文件列表
function processDocumentList(iframeDoc) {
  console.log('Processing document list, already processed:', documentProcessCount);
  
  // 1. 找到公文清單
  const listContainer = iframeDoc.querySelector('#listContainer');
  if (!listContainer) {
    console.log('Public document list (#listContainer) not found');
    processingInProgress = false;
    return;
  }
  console.log('Public document list found');

  // 2. 獲取所有核取方塊並檢查狀態
  const checkboxes = iframeDoc.querySelectorAll('#listTBODY tr input[type="checkbox"][name="ids"]');
  console.log('Found', checkboxes.length, 'checkboxes');
  
  if (checkboxes.length === 0) {
    console.log('No checkboxes found, disabling auto function');
    autoEnabled = false;
    chrome.storage.local.set({autoEnabled: false});
    updateStatusButton(false);
    showNotification('自動存查功能已停用', '無可存查的公文');
    processingInProgress = false;
    return;
  }

  // 3. 找到第一個未勾選的核取方塊
  let foundUnchecked = false;
  for (let i = 0; i < checkboxes.length; i++) {
    const checkbox = checkboxes[i];
    if (!checkbox.checked) {
      checkbox.checked = true;
      foundUnchecked = true;
      console.log('Checkbox checked:', checkbox.value);
      documentProcessCount++;

      // 處理 iCheck 樣式
      const iCheckDiv = checkbox.parentElement;
      if (iCheckDiv && iCheckDiv.classList.contains('icheckbox_minimal-orange')) {
        iCheckDiv.classList.add('checked');
      }

      // 4. 點擊存查按鈕
      const saveButton = findSaveButton(iframeDoc);
      if (saveButton) {
        console.log('Found save button, clicking it');
        const clickEvent = new Event('click', { bubbles: true });
        saveButton.dispatchEvent(clickEvent);
        console.log('Save button clicked');

        // 記錄成功使用的按鈕資訊
        if (saveButton.name) {
          console.log('Successful button ID:', saveButton.name);
        }

        // 等待頁面跳轉並重置狀態
        setTimeout(() => {
          processingInProgress = false;
          hasProcessedArchive = false; // 重置存檔標記，確保下次存檔頁面能處理
          console.log('Processing completed, ready for next document');
          // 強制重新檢查 iframe，避免遺漏頁面變化
          setTimeout(checkIframeAndAutomate, 1000);
        }, 5000); // 增加等待時間，確保頁面跳轉完成
      } else {
        console.log('Save button not found with any method');
        showNotification('自動存查失敗', '無法找到存查按鈕，請手動操作');
        processingInProgress = false;
      }
      break; // 只處理第一個未勾選的項目
    }
  }

  if (!foundUnchecked) {
    console.log('No unchecked checkboxes found, disabling auto function');
    autoEnabled = false;
    chrome.storage.local.set({autoEnabled: false});
    updateStatusButton(false);
    showNotification('自動存查功能已停用', '無可存查的公文');
    processingInProgress = false;
  }
}
// 等待元素出現的輔助函數
function waitForElement(selector, iframeDoc, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const element = iframeDoc.querySelector(selector);
    if (element) return resolve(element); // 如果元素已存在，立即返回
    const startTime = Date.now();
    const interval = setInterval(() => {
      const el = iframeDoc.querySelector(selector);
      if (el) {
        clearInterval(interval);
        resolve(el); // 找到元素後清除計時器並返回
      } else if (Date.now() - startTime > timeout) {
        clearInterval(interval);
        reject(new Error(`Timeout waiting for ${selector}`)); // 超時後報錯
      }
    }, 100); // 每 100ms 檢查一次
  });
}

// 處理存檔頁面的表單 (修正版)
async function processArchiveForm(iframeDoc) {
  console.log('Processing archive form with settings - 檔號:', CONFIG.fileNumber, '案次號:', CONFIG.caseNumber);

  // 延遲執行，確保頁面元素已完全載入
  try {
    // 1. 選擇檔號
    const fileTypeSelect = await waitForElement('select[name="q_fsKindno"]', iframeDoc); // 等待檔號選擇框出現
    if (fileTypeSelect) {
      // 確保使用最新的設定值
      fileTypeSelect.value = CONFIG.fileNumber; // 設置檔號
      console.log('File type set to:', fileTypeSelect.value);
      const changeEvent = new Event('change', { bubbles: true });
      fileTypeSelect.dispatchEvent(changeEvent); // 觸發變更事件，確保頁面更新
      console.log('檔號選擇框已觸發 change 事件');
    } else {
      console.log('File type select not found'); // 找不到檔號選擇框
      showNotification('存檔失敗', '無法找到檔號選擇框，請檢查頁面');
      processingInProgress = false;
      return;
    }

    // 2. 自動選擇案次號
    const caseNoSelect = await waitForElement('select[name="q_caseno"]', iframeDoc); // 等待案次號選擇框出現
    if (caseNoSelect) {
      // 檢查案次號選項是否已加載
      if (caseNoSelect.options.length > 1) { // 通常至少有一個預設選項
        caseNoSelect.value = CONFIG.caseNumber; // 設置案次號
        console.log('Case number set to:', caseNoSelect.value);
        const caseChangeEvent = new Event('change', { bubbles: true });
        caseNoSelect.dispatchEvent(caseChangeEvent); // 觸發變更事件，確保頁面更新
        console.log('案次號選擇框已觸發 change 事件');

        // 3. 點擊「確定存檔」按鈕
        const submitButton = await waitForElement('input[name="updateSubmit"][value="確定存檔"]', iframeDoc); // 等待確定存檔按鈕出現
        if (submitButton) {
          submitButton.click();
          console.log('Submit button clicked'); // 按鈕已點擊
          
          // 等待存檔完成並重置狀態
          setTimeout(() => {
            processingInProgress = false;
            console.log('Archive processing completed, ready for next document');
          }, 3000); // 等待 3 秒確保頁面處理完成
        } else {
          console.log('Submit button not found'); // 找不到確定存檔按鈕
          showNotification('存檔失敗', '無法找到確定存檔按鈕，請檢查頁面');
          processingInProgress = false;
          return;
        }
      } else {
        console.log('Case number options not fully loaded'); // 案次號選項未載入
        showNotification('存檔失敗', '案次號選項未載入，請檢查頁面或稍後重試');
        processingInProgress = false;
        return;
      }
    } else {
      console.log('Case number select not found'); // 找不到案次號選擇框
      showNotification('存檔失敗', '無法找到案次號選擇框，請檢查頁面');
      processingInProgress = false;
      return;
    }
  } catch (e) {
    console.log('存檔處理發生錯誤:', e.message); // 記錄任何異常
    showNotification('存檔失敗', `處理存檔時發生錯誤: ${e.message}`);
    processingInProgress = false;
  }
}
// 設置自動關閉計時器
function setAutoDisableTimer() {
  // 清除現有計時器（如果有）
  if (autoDisableTimer) {
    clearTimeout(autoDisableTimer);
  }
  
  // 設置新計時器 - 使用CONFIG中的設定時間
  autoDisableTimer = setTimeout(() => {
    if (autoEnabled) {
      autoEnabled = false;
      chrome.storage.local.set({autoEnabled: false}); // 使用 chrome.storage
      updateStatusButton(false);
      console.log(`自動存查功能已自動關閉 (${CONFIG.autoDisableTime}分鐘超時)`);
      
      // 顯示通知
      showNotification('自動存查功能已自動關閉', `已經過${CONFIG.autoDisableTime}分鐘，自動化功能已自動關閉。`);
    }
  }, CONFIG.autoDisableTime * 60 * 1000); // 轉換為毫秒
}


/// 顯示通知
function showNotification(title, message) {
  const notification = document.createElement('div');
  notification.className = 'auto-disable-notification';
  notification.innerHTML = `
    <div class="notification-title">${title}</div>
    <div class="notification-message">${message}</div>
  `;
  
  // 添加樣式
  const style = document.createElement('style');
  style.textContent = `
    .auto-disable-notification {
      position: fixed;
      bottom: 20px;
      right: 20px;
      background-color: #333;
      color: white;
      padding: 15px;
      border-radius: 5px;
      box-shadow: 0 3px 10px rgba(0,0,0,0.2);
      z-index: 10000;
      max-width: 300px;
      animation: fadeInOut 8s forwards; /* 延長顯示時間 */
    }
    .notification-title {
      font-weight: bold;
      margin-bottom: 5px;
      color: #ff5252; /* 紅色標題，更醒目 */
    }
    .notification-message {
      font-size: 14px;
    }
    @keyframes fadeInOut {
      0% { opacity: 0; transform: translateY(20px); }
      10% { opacity: 1; transform: translateY(0); }
      80% { opacity: 1; transform: translateY(0); }
      100% { opacity: 0; transform: translateY(-20px); }
    }
  `;
  
  document.head.appendChild(style);
  document.body.appendChild(notification);
  
  // 8秒後移除通知，延長顯示時間
  setTimeout(() => {
    notification.remove();
  }, 8000);
}



// 創建浮動狀態按鈕
// 創建浮動狀態按鈕 - 美觀版
function createStatusButton() {
  // 檢查是否已存在按鈕，避免重複創建
  if (document.getElementById('autoStatusButton')) {
    return;
  }

  // 創建按鈕容器
  const statusButton = document.createElement('div');
  statusButton.id = 'autoStatusButton';
  statusButton.innerHTML = `
    <div class="button-content">
      <div class="status-icon"></div>
      <span class="status-text">自動存查: 禁用</span>
      <div class="status-counter">0</div>
    </div>
    <div id="currentSettings" class="settings-display"></div>
  `;
  
  // 添加樣式
  const styles = document.createElement('style');
  styles.textContent = `
    #autoStatusButton {
      position: fixed;
      top: 20px;
      right: 20px;
      background-color: rgba(255, 255, 255, 0.95);
      border-radius: 50px;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
      padding: 8px 12px;
      font-family: 'Microsoft JhengHei', Arial, sans-serif;
      font-size: 13px;
      z-index: 9999;
      transition: all 0.3s ease;
      cursor: pointer;
      user-select: none;
      border: 1px solid #eaeaea;
      min-width: 36px;
      max-width: 250px;
    }
    
    #autoStatusButton:hover {
      box-shadow: 0 3px 12px rgba(0, 0, 0, 0.15);
      transform: translateY(-2px);
    }
    
    #autoStatusButton.active {
      border-radius: 12px;
      background-color: rgba(255, 255, 255, 0.98);
      border: 1px solid rgba(76, 175, 80, 0.3);
      padding: 10px 15px;
    }
    
    #autoStatusButton .button-content {
      display: flex;
      align-items: center;
      white-space: nowrap;
    }
    
    #autoStatusButton .status-icon {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      background-color: #ff5252;
      margin-right: 8px;
      transition: all 0.3s ease;
      flex-shrink: 0;
    }
    
    #autoStatusButton.active .status-icon {
      background-color: #4caf50;
    }
    
    #autoStatusButton .status-text {
      color: #666;
      transition: all 0.3s ease;
      font-weight: 500;
    }
    
    #autoStatusButton.active .status-text {
      color: #4caf50;
    }
    
    #autoStatusButton .status-counter {
      background-color: #f0f0f0;
      color: #666;
      font-size: 11px;
      font-weight: bold;
      height: 18px;
      min-width: 18px;
      border-radius: 9px;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0 4px;
      margin-left: 6px;
      transition: all 0.3s ease;
      opacity: 0;
      width: 0;
      overflow: hidden;
    }
    
    #autoStatusButton.active .status-counter {
      background-color: #4caf50;
      color: white;
      opacity: 1;
      width: auto;
    }
    
    #autoStatusButton .settings-display {
      margin-top: 6px;
      font-size: 12px;
      color: #888;
      display: none;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 100%;
      transition: all 0.3s ease;
    }
    
    #autoStatusButton.active .settings-display {
      display: block;
      animation: fadeIn 0.3s forwards;
    }
    
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(-5px); }
      to { opacity: 1; transform: translateY(0); }
    }
    
    @keyframes pulse {
      0% { transform: scale(1); }
      50% { transform: scale(1.1); }
      100% { transform: scale(1); }
    }
    
    #autoStatusButton.active .status-icon.processing {
      animation: pulse 1s infinite;
    }
  `;
  
  document.head.appendChild(styles);
  document.body.appendChild(statusButton);
  
  // 點擊按鈕時切換狀態
  statusButton.addEventListener('click', function() {
    toggleAuto();
  });
  
  return statusButton;
}

// 更新按鈕狀態 - 兼容新設計
function updateStatusButton(isActive) {
  const statusButton = document.getElementById('autoStatusButton');
  if (!statusButton) return;
  
  const statusText = statusButton.querySelector('.status-text');
  const statusCounter = statusButton.querySelector('.status-counter');
  
  if (isActive) {
    statusButton.classList.add('active');
    statusText.textContent = '自動存查: 啟用';
    
    // 當處理中時可以添加脈衝動畫
    if (processingInProgress) {
      statusButton.querySelector('.status-icon').classList.add('processing');
    } else {
      statusButton.querySelector('.status-icon').classList.remove('processing');
    }
    
    // 更新計數器
    statusCounter.textContent = documentProcessCount.toString();
  } else {
    statusButton.classList.remove('active');
    statusText.textContent = '自動存查: 禁用';
    statusButton.querySelector('.status-icon').classList.remove('processing');
    statusCounter.textContent = '0';
  }
  updateSettingsDisplay(); // 確保每次更新狀態時也更新顯示
}


//新增更新顯示設定的函數 20250320
function updateSettingsDisplay() {
  const settingsDisplay = document.getElementById('currentSettings');
  if (settingsDisplay) {
      if (autoEnabled) {
          settingsDisplay.textContent = `目前存查 - 檔號: ${CONFIG.fileNumber}, 案次號: ${CONFIG.caseNumber}`;
      } else {
          settingsDisplay.textContent = '';
      }
  }
}




// 切換自動化狀態
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
  chrome.storage.local.set({autoEnabled: autoEnabled});
  updateStatusButton(autoEnabled);
  updateSettingsDisplay(); // 更新顯示
  
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
  
  console.log('自動存查:', autoEnabled ? '啟用' : '禁用');
  return autoEnabled;
}


// 獲取當前狀態 - 改為始終返回 false，確保每次載入頁面都是關閉狀態
function getAutoStatus() {
  // 返回當前記憶體中的狀態值
  return autoEnabled;
}

// 初始化
function initialize() {
  createStatusButton();
  
  // 載入設定
  loadSettings();
  
  // 每次頁面加載時，強制設置為關閉狀態
  autoEnabled = false;
  chrome.storage.local.set({autoEnabled: false}); // 使用 chrome.storage 而非 localStorage
  updateStatusButton(false);
  
  // 重置變數
  hasProcessedArchive = false;
  lastProcessedUrl = '';
  processingInProgress = false;
  documentProcessCount = 0;
  
  // 初始化時檢查 iframe
  setTimeout(checkIframeAndAutomate, 1000); // 延遲確保頁面已加載
}


// 頁面加載完成後初始化
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initialize);
} else {
  initialize();
}

// 監聽 iframe 內容重新載入
document.addEventListener('DOMContentLoaded', () => {
  const iframe = document.getElementById('dTreeContent');
  if (iframe) {
    iframe.addEventListener('load', () => {
      if (autoEnabled) {
        console.log('Iframe reloaded, checking for automation');
        // 延遲一段時間再檢查，確保頁面完全載入
        setTimeout(() => {
          if (!processingInProgress) {
            checkIframeAndAutomate();
          }
        }, 1000);
      }
    });
  }
});

// 定期檢查 iframe URL 變化
setInterval(() => {
  if (autoEnabled && !processingInProgress) {
    const iframe = document.getElementById('dTreeContent');
    if (iframe && iframe.contentWindow.location.href !== lastProcessedUrl) {
      checkIframeAndAutomate();
    }
  }
}, 5000);

// 監聽頁面變化
const observer = new MutationObserver((mutations) => {
  if (autoEnabled && !processingInProgress) {
    // 檢查是否有相關的DOM變化
    for (const mutation of mutations) {
      if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
        // 延遲檢查，確保頁面已完全更新
        setTimeout(checkIframeAndAutomate, 500);
        break;
      }
    }
  }
});

// 開始觀察整個文檔的變化
observer.observe(document.body, {
  childList: true,
  subtree: true
});
