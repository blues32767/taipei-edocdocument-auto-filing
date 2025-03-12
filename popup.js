document.addEventListener('DOMContentLoaded', function() {
  const autoToggle = document.getElementById('autoToggle');
  const statusIndicator = document.getElementById('statusIndicator');
  const fileNumberInput = document.getElementById('fileNumber');
  const caseNumberInput = document.getElementById('caseNumber');
  const saveSettingsBtn = document.getElementById('saveSettings');

  // 從 storage 中讀取設定
  chrome.storage.local.get(['autoEnabled', 'fileNumber', 'caseNumber'], function(result) {
    // 更新介面
    updateToggleStatus(result.autoEnabled === true);
    
    // 填入已儲存的檔號和案次號
    if (result.fileNumber) {
      fileNumberInput.value = result.fileNumber;
      console.log('已載入檔號:', result.fileNumber);
    }
    if (result.caseNumber) {
      caseNumberInput.value = result.caseNumber;
      console.log('已載入案次號:', result.caseNumber);
    }
  });
  // 修改 popup.js 中的儲存設定部分
saveSettingsBtn.addEventListener('click', function() {
  const fileNumber = fileNumberInput.value.trim();
  const caseNumber = caseNumberInput.value.trim();
  
  // 檢查輸入是否有效
  if (!fileNumber || !caseNumber) {
    statusIndicator.textContent = '請填寫檔號和案次號';
    statusIndicator.style.color = '#ff5252';
    return;
  }
  
  // 儲存設定到 storage
  chrome.storage.local.set({
    fileNumber: fileNumber,
    caseNumber: caseNumber
  }, function() {
    // 顯示儲存成功訊息
    statusIndicator.textContent = '設定已儲存';
    statusIndicator.style.color = '#4caf50';
    
    // 正確通知 content script 更新設定
    chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
      chrome.tabs.sendMessage(tabs[0].id, {
        updateSettings: true,
        fileNumber: fileNumber,
        caseNumber: caseNumber
      }, function(response) {
        console.log('設定更新回應:', response);
      });
    });
    
    // 3秒後清除訊息
    setTimeout(() => {
      statusIndicator.textContent = '';
    }, 3000);
  });
});


  // 切換自動存查功能
  autoToggle.addEventListener('click', function() {
    chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
      chrome.tabs.sendMessage(tabs[0].id, {toggleAuto: true}, function(response) {
        if (response && response.status !== undefined) {
          updateToggleStatus(response.status);
        }
      });
    });
  });

  // 更新切換按鈕狀態
  function updateToggleStatus(isEnabled) {
    if (isEnabled) {
      autoToggle.classList.add('active');
      autoToggle.textContent = '關閉自動存查功能';
      statusIndicator.textContent = '自動存查已啟用';
    } else {
      autoToggle.classList.remove('active');
      autoToggle.textContent = '開啟自動存查功能';
      statusIndicator.textContent = '自動存查已關閉';
    }
  }
});
