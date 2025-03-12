
// /**
//  * 公文系統自動存查
//  * @author blues32767
//  * @version 2.0.0
//  * @created taiwan 2025/03/11
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
    // 使用 toggleAuto 函數來確保檢查頁面支援
    const status = toggleAuto();
    sendResponse({status: status});
  } 
  else if (request.updateSettings) {
    // 更新設定
    if (request.fileNumber) CONFIG.fileNumber = request.fileNumber;
    if (request.caseNumber) CONFIG.caseNumber = request.caseNumber;
    console.log('設定已更新 - 檔號:', CONFIG.fileNumber, '案次號:', CONFIG.caseNumber);
    // 添加回應
    sendResponse({success: true, fileNumber: CONFIG.fileNumber, caseNumber: CONFIG.caseNumber});
  }
  else if (request.checkStatus) {
    sendResponse({status: getAutoStatus()});
  }
  return true; // 保留這行，確保異步回應能正常工作
});

  
// 獲取 iframe URL 並執行相應的自動化操作
function checkIframeAndAutomate() {
  if (processingInProgress) {
    console.log('Processing in progress, skipping check');
    return;
  }

  const iframe = document.getElementById('dTreeContent');
  
  if (iframe) {
    currentIframe = iframe;
    try {
      currentIframeUrl = iframe.contentWindow.location.href;
      console.log('Current iframe URL:', currentIframeUrl);
      console.log('Iframe src attribute:', iframe.src);
      
      // 如果自動化功能已啟用
      if (autoEnabled) {
        // 檢查是否為可能的存查頁面 (基於 URL 的初步判斷)
        if (/AOSDA006F_s02\.jsp/.test(currentIframeUrl)) {
          // 進一步檢查頁面是否有「存查」按鈕
          const hasButton = checkPageHasSaveButton(iframe);
          
          if (hasButton) {
            console.log('找到存查按鈕，頁面支援自動存查');
            automateCheckActions(iframe);
          } else {
            console.log('未找到存查按鈕，此頁面不支援自動存查');
            showNotification('頁面不支援', '未找到存查按鈕，此頁面不支援自動存查功能');
            
            // 自動停用功能
            autoEnabled = false;
            chrome.storage.local.set({autoEnabled: false});
            updateStatusButton(false);
            
            // 清除自動關閉計時器
            if (autoDisableTimer) {
              clearTimeout(autoDisableTimer);
              autoDisableTimer = null;
            }
            
            console.log('由於頁面不支援，自動存查功能已停用');
          }
        } 
        // 檢查是否為存檔頁面
        else if (currentIframeUrl.includes('AOSDA062F_s18.jsp')) {
          console.log('On archive page, processing archive form');
          automateArchiveActions(iframe);
        }
      }
    } catch (e) {
      console.error('Error accessing iframe URL:', e);
    }
  } else {
    console.log('Iframe with id "dTreeContent" not found');
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
  
  // 等待 iframe 內容完全加載
  if (iframeDoc.readyState === 'complete') {
    console.log('Iframe ready, automating archive actions');
    processArchiveForm(iframeDoc);
    hasProcessedArchive = true; // 標記為已處理
  } else {
    iframe.addEventListener('load', () => {
      console.log('Iframe loaded, automating archive actions');
      processArchiveForm(iframeDoc);
      hasProcessedArchive = true; // 標記為已處理
    }, { once: true }); // 確保事件只觸發一次
  }
}

// 嘗試找到存查按鈕的函數
function findSaveButton(iframeDoc) {
  // 方法 1: 直接使用 value 屬性查找
  const valueButton = iframeDoc.querySelector('input[value="存查"]');
  if (valueButton) {
    console.log('找到存查按鈕 (透過 value 屬性)');
    return valueButton;
  }
  
  // 方法 2: 查找包含 "存查" 文字的按鈕
  const allInputs = iframeDoc.querySelectorAll('input[type="button"], input[type="submit"]');
  for (const input of allInputs) {
    if (input.value === "存查") {
      console.log('找到存查按鈕 (透過按鈕文字)');
      return input;
    }
  }
  
  // 方法 3: 查找包含 "存查" 文字的任何元素
  const allElements = iframeDoc.querySelectorAll('*');
  for (const element of allElements) {
    if (element.textContent && element.textContent.includes("存查") && 
        (element.tagName === 'BUTTON' || element.tagName === 'INPUT' || 
         element.onclick || element.getAttribute('onclick'))) {
      console.log('找到存查按鈕 (透過元素文字和標籤)');
      return element;
    }
  }
  
  // 方法 4: 嘗試常見的 ID 模式
  const commonIds = ['000011803', '000011703', '000011903', '000011603'];
  for (const id of commonIds) {
    const button = iframeDoc.querySelector(`input[name="${id}"][value="存查"]`);
    if (button) {
      console.log(`找到存查按鈕 (使用常見 ID: ${id})`);
      return button;
    }
  }
  
  console.log('未找到存查按鈕');
  return null;
}


// 處理存查頁面的文件列表
function processDocumentList(iframeDoc) {
  console.log('Processing document list, already processed:', documentProcessCount);
  
  // 1. 找到公文清單 (確認存在 #listContainer)
  const listContainer = iframeDoc.querySelector('#listContainer');
  if (listContainer) {
    console.log('Public document list found');

    // 2. 勾選第一個未處理的核取方塊
    const checkboxes = iframeDoc.querySelectorAll('#listTBODY tr input[type="checkbox"][name="ids"]');
    let foundUnchecked = false;
    
    console.log('Found', checkboxes.length, 'checkboxes');
    
    // 如果沒有找到任何核取方塊，或者找到的數量為0
    if (checkboxes.length === 0) {
      console.log('No checkboxes found, disabling auto function');
      autoEnabled = false;
      chrome.storage.local.set({autoEnabled: false});
      updateStatusButton(false);
      showNotification('自動存查功能已停用', '無可存查的公文');
      processingInProgress = false;
      return;
    }
    
    for (let i = 0; i < checkboxes.length; i++) {
      const checkbox = checkboxes[i];
      // 檢查是否已勾選
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

        // 3. 找到並點擊存查按鈕
        const saveButton = findSaveButton(iframeDoc);
        if (saveButton) {
          console.log('Found save button, clicking it');
          setTimeout(() => {
            const clickEvent = new Event('click', { bubbles: true });
            saveButton.dispatchEvent(clickEvent);
            console.log('Save button clicked');
            
            // 記錄成功使用的按鈕資訊，以便後續使用
            if (saveButton.name) {
              console.log('Successful button ID:', saveButton.name);
              // 可以選擇將成功的 ID 儲存起來，以便下次優先使用
            }
            
            // 重要：設置一個計時器，在一段時間後重置處理狀態，允許下一次處理
            setTimeout(() => {
              processingInProgress = false;
              console.log('Processing completed, ready for next document');
            }, 3000); // 給予足夠的時間讓頁面跳轉和重新加載
          }, 500); // 延遲點擊，確保 UI 更新
        } else {
          console.log('Save button not found with any method');
          processingInProgress = false;
          showNotification('自動存查失敗', '無法找到存查按鈕，請手動操作');
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
  } else {
    console.log('Public document list (#listContainer) not found');
    processingInProgress = false;
  }
}


// 處理存檔頁面的表單 (修正版)
function processArchiveForm(iframeDoc) {
  console.log('Processing archive form with settings - 檔號:', CONFIG.fileNumber, '案次號:', CONFIG.caseNumber);

  // 延遲執行，確保頁面元素已完全載入
  setTimeout(() => {
    // 1. 選擇檔號
    const fileTypeSelect = iframeDoc.querySelector('select[name="q_fsKindno"]');
    if (fileTypeSelect) {
      // 確保使用最新的設定值
      fileTypeSelect.value = CONFIG.fileNumber;
      console.log('File type set to:', fileTypeSelect.value);
      const changeEvent = new Event('change', { bubbles: true });
      fileTypeSelect.dispatchEvent(changeEvent);
      
      // 增加等待時間，確保案次號選項完全加載
      setTimeout(() => {
        // 2. 自動選擇案次號
        const caseNoSelect = iframeDoc.querySelector('select[name="q_caseno"]');
        if (caseNoSelect) {
          // 檢查案次號選項是否已加載
          if (caseNoSelect.options.length > 1) { // 通常至少有一個預設選項
            caseNoSelect.value = CONFIG.caseNumber;
            console.log('Case number set to:', caseNoSelect.value);
            const caseChangeEvent = new Event('change', { bubbles: true });
            caseNoSelect.dispatchEvent(caseChangeEvent);
            
            // 等待案次號選擇後再點擊確定按鈕
            setTimeout(() => {
              // 3. 點擊「確定存檔」按鈕
              const submitButton = iframeDoc.querySelector('input[name="updateSubmit"][value="確定存檔"]');
              if (submitButton) {
                submitButton.click();
                console.log('Submit button clicked');
                
                setTimeout(() => {
                  processingInProgress = false;
                  console.log('Archive processing completed, ready for next document');
                }, 3000);
              } else {
                console.log('Submit button not found');
                processingInProgress = false;
              }
            }, 1000); // 增加等待時間
          } else {
            console.log('Case number options not fully loaded yet, waiting longer');
            // 如果案次號選項未完全加載，再等待一段時間後重試
            setTimeout(() => {
              if (caseNoSelect.options.length > 1) {
                caseNoSelect.value = CONFIG.caseNumber;
                console.log('Case number set to (retry):', caseNoSelect.value);
                const caseChangeEvent = new Event('change', { bubbles: true });
                caseNoSelect.dispatchEvent(caseChangeEvent);
                
                setTimeout(() => {
                  const submitButton = iframeDoc.querySelector('input[name="updateSubmit"][value="確定存檔"]');
                  if (submitButton) {
                    submitButton.click();
                    console.log('Submit button clicked after retry');
                    
                    setTimeout(() => {
                      processingInProgress = false;
                      console.log('Archive processing completed after retry');
                    }, 3000);
                  } else {
                    console.log('Submit button not found after retry');
                    processingInProgress = false;
                  }
                }, 1000);
              } else {
                console.log('Case number options still not loaded after waiting, giving up');
                processingInProgress = false;
              }
            }, 2000); // 再等待2秒
          }
        } else {
          console.log('Case number select not found');
          processingInProgress = false;
        }
      }, CONFIG.waitTimeForCaseOptions); // 使用可配置的等待時間
    } else {
      console.log('File type select not found');
      processingInProgress = false;
    }
  }, 1000); // 等待1秒讓頁面元素完全載入
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
function createStatusButton() {
  // 檢查是否已存在按鈕，避免重複創建
  if (document.getElementById('autoStatusButton')) {
      return;
  }

  // 創建按鈕容器
  const statusButton = document.createElement('div');
  statusButton.id = 'autoStatusButton';
  statusButton.innerHTML = `
      <div class="status-icon"></div>
      <span class="status-text">自動存查: 禁用</span>
  `;
  
  // 添加樣式
  const styles = document.createElement('style');
  styles.textContent = `
      #autoStatusButton {
          position: fixed;
          top: 20px;
          right: 20px;
          background-color: #ffffff;
          border-radius: 30px;
          box-shadow: 0 2px 10px rgba(0, 0, 0, 0.2);
          padding: 8px 15px;
          display: flex;
          align-items: center;
          font-family: Arial, sans-serif;
          font-size: 14px;
          z-index: 9999;
          transition: all 0.3s ease;
          cursor: pointer;
          user-select: none;
      }
      #autoStatusButton:hover {
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
          transform: translateY(-2px);
      }
      #autoStatusButton .status-icon {
          width: 12px;
          height: 12px;
          border-radius: 50%;
          background-color: #ff5252; /* 預設紅色 (禁用) */
          margin-right: 8px;
          transition: background-color 0.3s ease;
      }
      #autoStatusButton.active .status-icon {
          background-color: #4caf50; /* 啟用時為綠色 */
      }
      #autoStatusButton.active .status-text {
          color: #4caf50;
      }
      #autoStatusButton .status-text {
          color: #666;
          font-weight: 500;
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

// 更新按鈕狀態
function updateStatusButton(isActive) {
  const statusButton = document.getElementById('autoStatusButton');
  if (!statusButton) return;
  
  const statusText = statusButton.querySelector('.status-text');
  
  if (isActive) {
      statusButton.classList.add('active');
      statusText.textContent = '自動存查: 啟用';
  } else {
      statusButton.classList.remove('active');
      statusText.textContent = '自動存查: 禁用';
  }
}

// 切換自動化狀態
function toggleAuto() {
  // 如果要啟用功能
  if (!autoEnabled) {
    // 先檢查頁面是否有存查按鈕
    const iframe = document.getElementById('dTreeContent');
    if (iframe && /AOSDA006F_s02\.jsp/.test(currentIframeUrl)) {
      const hasButton = checkPageHasSaveButton(iframe);
      if (!hasButton) {
        showNotification('頁面不支援', '未找到存查按鈕，此頁面不支援自動存查功能');
        return false;
      }
    }
  }
  
  // 切換狀態
  autoEnabled = !autoEnabled;
  chrome.storage.local.set({autoEnabled: autoEnabled});
  updateStatusButton(autoEnabled);
  
  // 如果啟用了自動化功能，立即執行自動化操作並設置自動關閉計時器
  if (autoEnabled) {
    // 重置變數，確保可以重新開始處理
    hasProcessedArchive = false;
    lastProcessedUrl = '';
    processingInProgress = false;
    documentProcessCount = 0;
    checkIframeAndAutomate();
    setAutoDisableTimer();
  } else {
    // 如果禁用了，清除計時器
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
    checkIframeAndAutomate();
  }
}, 2000); // 每2秒檢查一次，更頻繁一些以確保不會錯過操作

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
