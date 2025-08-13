# Memory Leak Fixes for Discord Bot

## 1. Fix Tesseract Worker Management

Add proper worker cleanup:

```javascript
// In stop() method, add:
if (this.tesseractWorker) {
    await this.tesseractWorker.terminate();
    this.tesseractWorker = null;
    console.log('✅ Tesseract worker terminated');
}

// In initTesseractWorker(), add timeout:
async initTesseractWorker() {
    try {
        if (this.tesseractWorker) return;
        this.tesseractWorker = await Tesseract.createWorker();
        await this.tesseractWorker.reinitialize('eng');
        await this.tesseractWorker.setParameters({
            tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 ',
            tessedit_pageseg_mode: '6'
        });
        
        // Add worker timeout to prevent memory buildup
        setTimeout(async () => {
            if (this.tesseractWorker) {
                await this.tesseractWorker.terminate();
                this.tesseractWorker = null;
                console.log('🔄 Tesseract worker auto-terminated after timeout');
            }
        }, 30 * 60 * 1000); // 30 minutes
        
        console.log('✅ Tesseract worker initialized');
    } catch (error) {
        console.log('⚠️ Could not init Tesseract worker, falling back:', error.message);
        this.tesseractWorker = null;
    }
}
```

## 2. Fix Interval Management

```javascript
// Add proper interval cleanup
startScheduledMonitoring() {
    // Clear existing interval first
    if (this._scheduledMonitorInterval) {
        clearInterval(this._scheduledMonitorInterval);
        this._scheduledMonitorInterval = null;
    }
    
    if (this._scheduledMonitorActive) return;
    this._scheduledMonitorActive = true;
    
    console.log('⏰ Scheduled monitoring started...');
    this._scheduledMonitorInterval = setInterval(async () => {
        if (!this.isRunning) return;
        // ... existing logic
    }, 60 * 1000);
}

// Add cleanup method
stopScheduledMonitoring() {
    if (this._scheduledMonitorInterval) {
        clearInterval(this._scheduledMonitorInterval);
        this._scheduledMonitorInterval = null;
    }
    this._scheduledMonitorActive = false;
    console.log('⏰ Scheduled monitoring stopped');
}
```

## 3. Fix OCR Infinite Loops

```javascript
// Add maximum attempts to prevent infinite loops
async captureAndSendBanners() {
    const MAX_ATTEMPTS = 50; // Prevent infinite loops
    
    // Find X banner with attempt limit
    let xAttempts = 0;
    while (xAttempts < MAX_ATTEMPTS) {
        xAttempts++;
        // ... existing OCR logic
        
        if (xLabel === 'X BANNER') {
            // ... success logic
            break;
        }
        
        await new Promise(resolve => setTimeout(resolve, this.config.ocrSettings.attemptDelayMs));
    }
    
    if (xAttempts >= MAX_ATTEMPTS) {
        console.log('❌ [X] Max attempts reached, skipping X banner');
        return;
    }
    
    // Same for Y banner...
}
```

## 4. Add Memory Monitoring

```javascript
// Add memory monitoring method
logMemoryUsage() {
    const used = process.memoryUsage();
    console.log('📊 Memory Usage:');
    console.log(`   RSS: ${Math.round(used.rss / 1024 / 1024)} MB`);
    console.log(`   Heap Used: ${Math.round(used.heapUsed / 1024 / 1024)} MB`);
    console.log(`   Heap Total: ${Math.round(used.heapTotal / 1024 / 1024)} MB`);
    console.log(`   External: ${Math.round(used.external / 1024 / 1024)} MB`);
}

// Call this periodically in your monitoring loop
```

## 5. Browser Resource Management

```javascript
// Add proper page cleanup
async recreatePage() {
    try {
        // Close existing page properly
        if (this.page && !this.page.isClosed()) {
            await this.page.removeAllListeners();
            await this.page.close();
            this.page = null;
        }
        
        // Create new page
        this.page = await this.browser.newPage();
        await this.applyStealthMeasures();
        await this.page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
        await this.page.setViewport({ width: 1920, height: 1080 });
        
    } catch (error) {
        console.log('⚠️ Error recreating page:', error.message);
    }
}
```

## 6. Garbage Collection

```javascript
// Add manual garbage collection calls
async performCleanup() {
    // Clear image cache
    this.recentHashes = [];
    
    // Force garbage collection if available
    if (global.gc) {
        global.gc();
        console.log('🗑️ Forced garbage collection');
    }
    
    // Log memory usage
    this.logMemoryUsage();
}

// Call this periodically (every 10-15 minutes)
```

## Immediate Actions:

1. **Restart with memory limits**: Use `--max-old-space-size=2048` flag
2. **Add the Tesseract worker cleanup** (most critical)
3. **Limit OCR attempts** to prevent infinite loops
4. **Clear intervals properly** when restarting monitoring
5. **Monitor memory usage** with the logging function

## Launch Command:
```bash
node --max-old-space-size=2048 --expose-gc bot.js
```

This should reduce your memory usage from 20GB to under 1GB per bot.
