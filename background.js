// 監聽擴展圖標點擊事件
chrome.action.onClicked.addListener((tab) => {
    console.log('Extension icon clicked, tab ID:', tab.id);
});

// 監聽來自內容腳本的消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.autoStatus === "status") {
        // 這裡可以根據需要處理自動化狀態
        console.log('自動存查狀態:', request.status ? '啟用' : '禁用');
    }
});
