import { Client, GatewayIntentBits, AttachmentBuilder, Events } from 'discord.js';
import puppeteer from 'puppeteer';
import fs from 'fs';
import crypto from 'crypto';
import Tesseract from 'tesseract.js';

// Load environment variables
import dotenv from 'dotenv';
dotenv.config()

const config = {
    discordToken: process.env.DISCORD_TOKEN || 'your_discord_token_here',
    channelId: process.env.CHANNEL_ID || 'your_channel_id_here',
    roleId: process.env.ROLE_ID || 'your_role_id_here',
    livestreamUrl: process.env.LIVESTREAM_URL || 'https://www.youtube.com/watch?v=your_livestream_id',
    xBannerArea: {
        x: 50,
        y: 60,
        width: 1200,
        height: 650
    },
    yBannerArea: {
        x: 50,
        y: 60,
        width: 1200,
        height: 650
    },
    ocrArea: {
        x: 50,
        y: 50,
        width: 500,
        height: 150
    },
    captureStrategy: {
        xBannerMinute: 1,
        yBannerMinute: 31,
        minTimeBetweenCaptures: 30000,
        hashCacheSize: 5
    },
    ocrSettings: {
        attemptDelayMs: 250,
        roiType: 'jpeg',
        roiQuality: 60
    }
};

class ASTDXBannerBot {
    constructor(config) {
        this.config = config;
        this.client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent
            ]
        });
        
        // Browser and page are now created on-demand
        this.browser = null;
        this.page = null;
        this.isRunning = false;
        this.lastXBannerTime = 0;
        this.lastYBannerTime = 0;
        this.recentHashes = [];
        this.lastCaptureTime = 0;
        this.lastSentBannerNames = { X: null, Y: null };
        this.tesseractWorker = null;
        this.setupDiscordClient();
        
        // Schedule monitoring without browser
        this.scheduleMonitoringInterval = null;
    }

    // Initialize browser only when needed
    async initializeBrowser() {
        try {
            console.log('🚀 Initializing browser for capture...');

            // Set up browser with extensions
            const userDataDir = './browser-data';
            const path = await import('path');
            const fs = await import('fs');
            const extensionPath = path.resolve('./extensions/ublock-origin-lite');
            
            let extensionArgs = [];
            try {
                if (fs.existsSync(extensionPath) && fs.existsSync(path.join(extensionPath, 'manifest.json'))) {
                    console.log('✅ Extension directory found, loading uBlock Origin Lite');
                    extensionArgs = [`--load-extension=${extensionPath}`];
                } else {
                    console.log('⚠️ Extension directory not found, running without ad blocker');
                }
            } catch (error) {
                console.log('⚠️ Error checking extension directory:', error.message);
            }
            
            this.browser = await puppeteer.launch({
                headless: "new",
                userDataDir: userDataDir,
                args: [
                    '--disable-blink-features=AutomationControlled',
                    '--autoplay-policy=no-user-gesture-required',
                    '--disable-web-security',
                    '--disable-features=VizDisplayCompositor',
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--no-first-run',
                    '--no-zygote',
                    '--disable-gpu',
                    '--disable-background-timer-throttling',
                    '--disable-backgrounding-occluded-windows',
                    '--disable-renderer-backgrounding',
                    '--memory-pressure-off',
                    '--max_old_space_size=512',
                    '--disable-background-networking',
                    '--disable-default-apps',
                    '--disable-sync',
                    '--disable-translate',
                    '--hide-scrollbars',
                    '--mute-audio',
                    '--no-default-browser-check',
                    '--no-pings',
                    '--disable-plugins',
                    '--disable-background-media-suspend',
                    '--disable-component-extensions-with-background-pages',
                    '--disable-features=TranslateUI',
                    '--disable-ipc-flooding-protection',
                    ...extensionArgs
                ]
            });

            this.page = await this.browser.newPage();
            await this.applyStealthMeasures();
            await this.page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
            await this.page.setViewport({ width: 1920, height: 1080 });

            console.log('📺 Loading livestream...');
            await this.loadLivestream();
            
            console.log('✅ Browser initialized successfully');
            return true;
            
        } catch (error) {
            console.error('❌ Failed to initialize browser:', error);
            await this.closeBrowser();
            throw error;
        }
    }

    // Load livestream page with retry logic
    async loadLivestream() {
        let pageLoaded = false;
        let attempts = 0;
        const maxAttempts = 3;

        while (!pageLoaded && attempts < maxAttempts) {
            attempts++;
            console.log(`🔄 Loading attempt ${attempts}/${maxAttempts}...`);

            try {
                const waitStrategy = attempts === 1 ? 'networkidle2' : 'domcontentloaded';
                const timeout = attempts === 1 ? 60000 : 90000;

                await this.page.goto(this.config.livestreamUrl, {
                    waitUntil: waitStrategy,
                    timeout: timeout
                });

                pageLoaded = true;
                console.log('✅ Page loaded successfully');

            } catch (error) {
                console.log(`⚠️ Attempt ${attempts} failed: ${error.message}`);
                if (attempts < maxAttempts) {
                    console.log('⏳ Waiting 5 seconds before retry...');
                    await new Promise(resolve => setTimeout(resolve, 5000));
                }
            }
        }

        if (!pageLoaded) {
            throw new Error('Failed to load livestream after all attempts');
        }

        // Handle overlays and start video
        await this.handleYouTubeOverlaysEnhanced();
        await this.startVideoEnhanced();
        await new Promise(resolve => setTimeout(resolve, 5000)); // Wait for video to stabilize
    }

    // Close browser and free memory
    async closeBrowser() {
        try {
            console.log('🔄 Closing browser to free memory...');
            
            if (this.tesseractWorker) {
                try {
                    await this.tesseractWorker.terminate();
                    this.tesseractWorker = null;
                    console.log('✅ Tesseract worker terminated');
                } catch (error) {
                    console.log('⚠️ Error terminating Tesseract worker:', error.message);
                }
            }

            if (this.page && !this.page.isClosed()) {
                try {
                    await this.page.close();
                } catch (error) {
                    console.log('⚠️ Error closing page:', error.message);
                }
            }

            if (this.browser) {
                try {
                    await this.browser.close();
                } catch (error) {
                    console.log('⚠️ Error closing browser:', error.message);
                }
            }

            this.browser = null;
            this.page = null;
            this.tesseractWorker = null;

            // Force garbage collection if available
            if (global.gc) {
                global.gc();
                console.log('🗑️ Forced garbage collection');
            }

            console.log('✅ Browser closed and memory freed');
            
        } catch (error) {
            console.error('❌ Error closing browser:', error);
        }
    }

    // Memory usage reporting
    getMemoryUsage() {
        const used = process.memoryUsage();
        return {
            rss: Math.round(used.rss / 1024 / 1024 * 100) / 100,
            heapTotal: Math.round(used.heapTotal / 1024 / 1024 * 100) / 100,
            heapUsed: Math.round(used.heapUsed / 1024 / 1024 * 100) / 100,
            external: Math.round(used.external / 1024 / 1024 * 100) / 100
        };
    }

    // Initialize a persistent Tesseract worker for speed (only when needed)
    async initTesseractWorker() {
        try {
            if (this.tesseractWorker) return;
            this.tesseractWorker = await Tesseract.createWorker();
            await this.tesseractWorker.reinitialize('eng');
            await this.tesseractWorker.setParameters({
                tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 ',
                tessedit_pageseg_mode: '6'
            });
            console.log('✅ Tesseract worker initialized');
        } catch (error) {
            console.log('⚠️ Could not init Tesseract worker:', error.message);
            this.tesseractWorker = null;
        }
    }

    // OCR helper methods (same as before)
    async ocrTextFromImage(imageBuffer) {
        try {
            if (this.tesseractWorker) {
                const { data: { text } } = await this.tesseractWorker.recognize(imageBuffer);
                return (text || '').toUpperCase();
            }
            const { data: { text } } = await Tesseract.recognize(imageBuffer, 'eng', {
                tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 ',
                psm: 6
            });
            return (text || '').toUpperCase();
        } catch (error) {
            console.error('OCR error:', error);
            return '';
        }
    }

    extractBannerLabel(ocrTextUpper) {
        const match = ocrTextUpper.match(/\b([XY])\s*BANNER\b/);
        return match ? match[0] : null;
    }

    async captureRegionForOcr(area, debugName = null) {
        try {
            const options = {
                clip: { x: area.x, y: area.y, width: area.width, height: area.height },
                type: this.config.ocrSettings.roiType || 'jpeg'
            };
            if (options.type === 'jpeg') {
                options.quality = this.config.ocrSettings.roiQuality || 60;
            }
            return await this.page.screenshot(options);
        } catch (error) {
            console.error('❌ Failed to capture OCR region:', error);
            return null;
        }
    }

    // Main capture method - now opens and closes browser
    async captureAndSendBanners() {
        const memoryBefore = this.getMemoryUsage();
        console.log(`📊 Memory before capture: RSS: ${memoryBefore.rss}MB, Heap: ${memoryBefore.heapUsed}MB`);

        try {
            // Initialize browser
            await this.initializeBrowser();
            
            // Reset duplicate detection
            this.recentHashes = [];
            this.lastSentBannerNames = { X: null, Y: null };
            
            // Initialize OCR worker
            await this.initTesseractWorker();

            // Find X banner
            await this.findAndCaptureXBanner();
            
            // Find Y banner
            await this.findAndCaptureYBanner();

            console.log('✅ Banner capture session completed successfully');

        } catch (error) {
            console.error('❌ Error during banner capture:', error);
            await this.sendErrorToDiscord('Banner capture failed: ' + error.message);
        } finally {
            // Always close browser after capture
            await this.closeBrowser();
            
            const memoryAfter = this.getMemoryUsage();
            console.log(`📊 Memory after capture: RSS: ${memoryAfter.rss}MB, Heap: ${memoryAfter.heapUsed}MB`);
            console.log(`📈 Memory freed: RSS: ${(memoryBefore.rss - memoryAfter.rss).toFixed(2)}MB`);
        }
    }

    // Find and capture X banner
    async findAndCaptureXBanner() {
        let xAttempts = 0;
        while (true) {
            xAttempts++;
            console.log(`🔎 [X] Attempt ${xAttempts}: Capturing OCR ROI...`);
            
            const xLabelRoi = await this.captureRegionForOcr(this.config.ocrArea, `x_label_attempt_${xAttempts}`);
            if (!xLabelRoi) {
                console.log('❌ [X] OCR ROI capture failed.');
                await new Promise(resolve => setTimeout(resolve, this.config.ocrSettings.attemptDelayMs));
                continue;
            }

            const xTextLabel = await this.ocrTextFromImage(xLabelRoi);
            const xLabel = this.extractBannerLabel(xTextLabel);
            console.log(`🔤 [X] OCR detected: label=${xLabel || 'none'}`);

            if (xLabel === 'X BANNER') {
                console.log('[X] Correct X banner detected.');
                const xScreenshot = await this.captureBannerScreenshot(this.config.xBannerArea);
                if (!xScreenshot) {
                    console.log('❌ [X] Full screenshot failed after detection, retrying...');
                    await new Promise(resolve => setTimeout(resolve, this.config.ocrSettings.attemptDelayMs));
                    continue;
                }
                
                if (this.lastSentBannerNames.X !== xLabel) {
                    if (this.isDuplicateImage(xScreenshot)) {
                        console.log('🚫 [X] Duplicate image detected, not sending.');
                    } else {
                        await this.sendToDiscord(xScreenshot, 'X Banner', '');
                        this.lastSentBannerNames.X = xLabel;
                        console.log('✅ [X] Banner sent to Discord.');
                    }
                } else {
                    console.log('🚫 [X] Duplicate X Banner name, not sending.');
                }
                break;
            }

            await new Promise(resolve => setTimeout(resolve, this.config.ocrSettings.attemptDelayMs));
        }
    }

    // Find and capture Y banner
    async findAndCaptureYBanner() {
        let yAttempts = 0;
        while (true) {
            yAttempts++;
            console.log(`🔎 [Y] Attempt ${yAttempts}: Capturing OCR ROI...`);
            
            const yLabelRoi = await this.captureRegionForOcr(this.config.ocrArea, `y_label_attempt_${yAttempts}`);
            if (!yLabelRoi) {
                console.log('❌ [Y] OCR ROI capture failed.');
                await new Promise(resolve => setTimeout(resolve, this.config.ocrSettings.attemptDelayMs));
                continue;
            }

            const yTextLabel = await this.ocrTextFromImage(yLabelRoi);
            const yLabel = this.extractBannerLabel(yTextLabel);
            console.log(`🔤 [Y] OCR detected: label=${yLabel || 'none'}`);

            if (yLabel === 'Y BANNER') {
                console.log('[Y] Correct banner was detected.');
                const yScreenshot = await this.captureBannerScreenshot(this.config.yBannerArea);
                if (!yScreenshot) {
                    console.log('❌ [Y] Full screenshot failed after detection, retrying...');
                    await new Promise(resolve => setTimeout(resolve, this.config.ocrSettings.attemptDelayMs));
                    continue;
                }
                
                if (this.lastSentBannerNames.Y !== yLabel) {
                    if (this.isDuplicateImage(yScreenshot)) {
                        console.log('🚫 [Y] Duplicate image detected, not sending.');
                    } else {
                        await this.sendToDiscord(yScreenshot, 'Y Banner', '', false);
                        this.lastSentBannerNames.Y = yLabel;
                        console.log('✅ [Y] Banner screenshot sent to Discord (no message).');
                    }
                } else {
                    console.log('🚫 [Y] Duplicate Y Banner name, not sending.');
                }
                break;
            }

            await new Promise(resolve => setTimeout(resolve, this.config.ocrSettings.attemptDelayMs));
        }
    }

    async setupDiscordClient() {
        this.client.on(Events.ClientReady, () => {
            console.log(`✅ Bot logged in as ${this.client.user.tag}`);
            this.startScheduledMonitoring();
        });

        this.client.on(Events.MessageCreate, async (message) => {
            if (message.author.bot) return;

            if (message.content === '!test') {
                console.log('📋 Manual banner capture command received');
                const memoryBefore = this.getMemoryUsage();
                
                await this.captureAndSendBanners();
                
                const memoryAfter = this.getMemoryUsage();
                
            } else if (message.content === '!memory-status') {
                const memory = this.getMemoryUsage();
                const browserStatus = this.browser ? '🟢 Open' : '🔴 Closed';
                await message.reply(`📊 **Memory Status:**\n` +
                    `• RSS: ${memory.rss}MB\n` +
                    `• Heap Used: ${memory.heapUsed}MB / ${memory.heapTotal}MB\n` +
                    `• External: ${memory.external}MB\n` +
                    `• Browser: ${browserStatus}\n` +
                    `• Bot Running: ${this.isRunning ? 'Yes' : 'No'}`);
                
            } else if (message.content === '!status') {
                const memory = this.getMemoryUsage();
                await message.reply(`📋 **Bot Status:**\n` +
                    `• Running: ${this.isRunning ? '✅ Yes' : '❌ No'}\n` +
                    `• Browser: ${this.browser ? '🟢 Open' : '🔴 Closed'}\n` +
                    `• Memory: ${memory.rss}MB RSS, ${memory.heapUsed}MB Heap\n` +
                    `• Last X Banner: ${this.lastXBannerTime ? new Date(this.lastXBannerTime).toLocaleTimeString() : 'Never'}\n` +
                    `• Last Y Banner: ${this.lastYBannerTime ? new Date(this.lastYBannerTime).toLocaleTimeString() : 'Never'}`);
                    
            } else if (message.content === '!test-browser') {
                const memoryBefore = this.getMemoryUsage();
                await message.reply(`🧪 Testing browser initialization... (Memory: ${memoryBefore.rss}MB)`);
                
                try {
                    await this.initializeBrowser();
                    const memoryDuring = this.getMemoryUsage();
                    await message.reply(`✅ Browser initialized successfully! Memory: ${memoryDuring.rss}MB (+${(memoryDuring.rss - memoryBefore.rss).toFixed(2)}MB)`);
                    
                    await this.closeBrowser();
                    const memoryAfter = this.getMemoryUsage();
                    await message.reply(`🔄 Browser closed. Memory: ${memoryAfter.rss}MB (${(memoryBefore.rss - memoryAfter.rss > 0 ? 'Freed' : 'Used')} ${Math.abs(memoryBefore.rss - memoryAfter.rss).toFixed(2)}MB)`);
                    
                } catch (error) {
                    await message.reply(`❌ Browser test failed: ${error.message}`);
                    await this.closeBrowser();
                }
            } else if (message.content === '!force-gc' && global.gc) {
                const memoryBefore = this.getMemoryUsage();
                global.gc();
                const memoryAfter = this.getMemoryUsage();
                await message.reply(`🗑️ Forced garbage collection.\n` +
                    `Before: ${memoryBefore.rss}MB → After: ${memoryAfter.rss}MB\n` +
                    `Freed: ${(memoryBefore.rss - memoryAfter.rss).toFixed(2)}MB`);
            }
        });
    }

    // Scheduled monitoring without browser
    startScheduledMonitoring() {
        if (this.scheduleMonitoringInterval) {
            clearInterval(this.scheduleMonitoringInterval);
        }
        
        this.isRunning = true;
        console.log('⏰ Starting scheduled monitoring (browser opens only when needed)...');
        
        this.scheduleMonitoringInterval = setInterval(async () => {
            if (!this.isRunning) return;
            
            const now = new Date();
            const minute = now.getMinutes();
            const memory = this.getMemoryUsage();
            
            console.log(`⏰ Time check: ${now.toLocaleTimeString()} (${minute} min) - Memory: ${memory.rss}MB`);

            // Check if it's time to capture banners
            if (minute === this.config.captureStrategy.xBannerMinute || 
                minute === this.config.captureStrategy.yBannerMinute) {
                
                console.log(`⏰ Scheduled time reached (${minute}), starting banner capture...`);
                await this.captureAndSendBanners();
            }
            
        }, 60 * 1000); // Check every minute
    }

    // Enhanced stealth measures (same as before)
    async applyStealthMeasures() {
        try {
            await this.page.evaluateOnNewDocument(() => {
                delete navigator.__proto__.webdriver;
                Object.defineProperty(navigator, 'plugins', {
                    get: () => [1, 2, 3, 4, 5],
                });
                Object.defineProperty(navigator, 'languages', {
                    get: () => ['en-US', 'en'],
                });
                const originalQuery = window.navigator.permissions.query;
                window.navigator.permissions.query = (parameters) => (
                    parameters.name === 'notifications' ?
                        Promise.resolve({ state: Notification.permission }) :
                        originalQuery(parameters)
                );
                Object.defineProperty(window, 'chrome', {
                    writable: true,
                    enumerable: true,
                    configurable: true,
                    value: { runtime: {} },
                });
                Object.defineProperty(navigator, 'permissions', {
                    get: () => ({
                        query: async () => ({ state: 'granted' }),
                    }),
                });
            });

            await this.page.setExtraHTTPHeaders({
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept-Encoding': 'gzip, deflate, br',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
                'Cache-Control': 'no-cache',
                'Pragma': 'no-cache',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'none',
                'Sec-Fetch-User': '?1',
                'Upgrade-Insecure-Requests': '1'
            });

            console.log('✅ Stealth measures applied successfully');
        } catch (error) {
            console.error('❌ Error applying stealth measures:', error);
        }
    }

    // Enhanced overlay and video handling (same as before but adapted for on-demand browser)
    async handleYouTubeOverlaysEnhanced() {
        try {
            console.log('🔧 Handling YouTube overlays...');
            await new Promise(resolve => setTimeout(resolve, 3000));

            await this.page.evaluate(() => {
                const overlaySelectors = [
                    '[role="dialog"]:not([data-video-id])',
                    '.modal:not(.html5-video-player)',
                    '.popup:not(.ytp-player)',
                    '.overlay:not(.ytp-video-container)',
                    '.ytp-popup', '.ytp-pause-overlay',
                    '.ytp-gradient-top', '.ytp-gradient-bottom',
                    '[class*="consent"]', '[class*="Consent"]',
                    '[class*="cookie"]', '[class*="Cookie"]',
                    '[class*="privacy"]', '[class*="Privacy"]',
                    '[class*="gdpr"]', '[class*="GDPR"]'
                ];

                overlaySelectors.forEach(selector => {
                    const overlays = document.querySelectorAll(selector);
                    overlays.forEach(overlay => {
                        if (!overlay.closest('.html5-video-player') &&
                            !overlay.closest('.ytp-player') &&
                            !overlay.closest('video')) {
                            overlay.style.display = 'none';
                            overlay.style.visibility = 'hidden';
                            overlay.style.opacity = '0';
                            overlay.style.pointerEvents = 'none';
                        }
                    });
                });

                const buttons = document.querySelectorAll('button');
                buttons.forEach(button => {
                    const text = button.textContent.toLowerCase();
                    const ariaLabel = button.getAttribute('aria-label')?.toLowerCase() || '';
                    
                    if ((text.includes('accept') || text.includes('agree') || text.includes('continue') || 
                         text.includes('ok') || text.includes('yes') || text.includes('allow') ||
                         ariaLabel.includes('accept') || ariaLabel.includes('agree') || ariaLabel.includes('continue')) &&
                        !button.closest('.html5-video-player') &&
                        !button.closest('.ytp-player')) {
                        button.click();
                    }
                });

                document.body.style.overflow = 'auto';
                document.documentElement.style.overflow = 'auto';
            });

            await new Promise(resolve => setTimeout(resolve, 2000));
            console.log('✅ YouTube overlays handled');
        } catch (error) {
            console.error('❌ Error handling overlays:', error);
        }
    }

    async startVideoEnhanced() {
        try {
            console.log('▶️ Starting video...');
            await this.page.waitForSelector('video', { timeout: 10000 });
            await new Promise(resolve => setTimeout(resolve, 500));

            const played = await this.page.evaluate(async () => {
                const video = document.querySelector('video');
                if (video) {
                    try {
                        await video.play();
                        return !video.paused;
                    } catch (e) {
                        return false;
                    }
                }
                return false;
            });

            if (played) {
                console.log('✅ Video started via video.play()');
                return;
            }

            const playButtonSelectors = [
                '.ytp-large-play-button', '.ytp-play-button',
                'button[aria-label*="Play"]', 'button[aria-label*="play"]',
                'button[title*="Play"]', 'button[title*="play"]',
                '[class*="play-button"]', '[class*="PlayButton"]'
            ];

            for (const selector of playButtonSelectors) {
                try {
                    const button = await this.page.$(selector);
                    if (button) {
                        console.log(`🖱️ Clicking play button: ${selector}`);
                        await button.click();
                        await new Promise(resolve => setTimeout(resolve, 1500));
                        break;
                    }
                } catch (error) {
                    console.log(`⚠️ Error with play button ${selector}:`, error.message);
                }
            }

            console.log('✅ Video start completed');
        } catch (error) {
            console.error('❌ Error starting video:', error);
        }
    }

    // Helper methods (same logic as before)
    async captureBannerScreenshot(area) {
        try {
            return await this.page.screenshot({
                clip: { x: area.x, y: area.y, width: area.width, height: area.height }
            });
        } catch (error) {
            console.error('❌ Failed to capture banner screenshot:', error);
            return null;
        }
    }

    calculateImageHash(imageBuffer) {
        try {
            return crypto.createHash('md5').update(imageBuffer).digest('hex');
        } catch (error) {
            console.error('❌ Error calculating image hash:', error);
            return null;
        }
    }

    isDuplicateImage(imageBuffer) {
        try {
            const currentHash = this.calculateImageHash(imageBuffer);
            if (!currentHash) return false;

            if (this.recentHashes.includes(currentHash)) {
                console.log('🚫 Duplicate image detected, skipping...');
                return true;
            }

            this.recentHashes.push(currentHash);
            if (this.recentHashes.length > this.config.captureStrategy.hashCacheSize) {
                this.recentHashes.shift();
            }

            return false;
        } catch (error) {
            console.error('❌ Error checking for duplicate image:', error);
            return false;
        }
    }

    readBannerMessage() {
        try {
            const messagePath = './banner-message.txt';
            if (fs.existsSync(messagePath)) {
                const message = fs.readFileSync(messagePath, 'utf8').trim();
                return message || '🎯 New banner detected!';
            }
            return '🎯 New banner detected!';
        } catch (error) {
            console.error('❌ Error reading banner message file:', error);
            return '🎯 New banner detected!';
        }
    }

    async sendToDiscord(screenshotBuffer, filename, message, includeCustomMessage = true) {
        try {
            const channel = await this.client.channels.fetch(this.config.channelId);
            if (!channel) {
                throw new Error('Channel not found');
            }

            const attachment = new AttachmentBuilder(screenshotBuffer, {
                name: `${filename}_${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.png`
            });

            let fullMessage = '';
            
            if (includeCustomMessage) {
                const customMessage = this.readBannerMessage();
                const rolePing = this.config.roleId && this.config.roleId !== 'your_role_id_here' 
                    ? `<@&${this.config.roleId}>` 
                    : '';
                fullMessage = `${rolePing} ${customMessage}\n${message}\n`.trim();
            }

            await channel.send({
                content: fullMessage,
                files: [attachment]
            });

            console.log(`✅ Sent ${filename} to Discord${includeCustomMessage ? ' with message' : ' (screenshot only)'}`);
        } catch (error) {
            console.error('❌ Failed to send to Discord:', error);
        }
    }

    async sendErrorToDiscord(errorMessage) {
        try {
            const channel = await this.client.channels.fetch(this.config.channelId);
            if (!channel) {
                console.error('Channel not found for error message');
                return;
            }
            await channel.send(`❌ **Error:** ${errorMessage}\n`);
        } catch (error) {
            console.error('Failed to send error to Discord:', error);
        }
    }

    async start() {
        try {
            console.log('🚀 Starting memory-optimized banner bot...');
            const initialMemory = this.getMemoryUsage();
            console.log(`📊 Initial memory usage: RSS: ${initialMemory.rss}MB, Heap: ${initialMemory.heapUsed}MB`);
            
            await this.client.login(this.config.discordToken);
            console.log('✅ Bot started successfully in memory-optimized mode');
        } catch (error) {
            console.error('Failed to start bot:', error);
            throw error;
        }
    }

    async stop() {
        console.log('🛑 Stopping bot...');
        this.isRunning = false;

        try {
            // Clear scheduled monitoring
            if (this.scheduleMonitoringInterval) {
                clearInterval(this.scheduleMonitoringInterval);
                this.scheduleMonitoringInterval = null;
            }

            // Close browser if open
            await this.closeBrowser();

            if (this.client) {
                await this.client.destroy();
            }

            console.log('✅ Bot stopped successfully');
        } catch (error) {
            console.error('Error stopping bot:', error);
        }
    }
}

// Create bot instance
const bot = new ASTDXBannerBot(config);

// Handle graceful shutdown
process.on('SIGINT', async () => {
    console.log('🛑 Shutting down bot...');
    await bot.stop();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('🛑 Shutting down bot...');
    await bot.stop();
    process.exit(0);
});

// Handle uncaught exceptions
process.on('uncaughtException', async (error) => {
    console.error('Uncaught Exception:', error);
    await bot.stop();
    process.exit(1);
});

process.on('unhandledRejection', async (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    await bot.stop();
    process.exit(1);
});

// Start the bot
bot.start().catch(console.error);

export default ASTDXBannerBot;