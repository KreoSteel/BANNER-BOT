import { Client, GatewayIntentBits, AttachmentBuilder, Events } from 'discord.js';
import puppeteer from 'puppeteer';
import fs from 'fs';
import crypto from 'crypto';
import Tesseract from 'tesseract.js'; // Add this import at the top

// Load environment variables
import dotenv from 'dotenv';
dotenv.config()

const config = {
    discordToken: process.env.DISCORD_TOKEN || 'your_discord_token_here',
    channelId: process.env.CHANNEL_ID || 'your_channel_id_here',
    roleId: process.env.ROLE_ID || 'your_role_id_here', // Role to ping when banners are sent
    livestreamUrl: process.env.LIVESTREAM_URL || 'https://www.youtube.com/watch?v=your_livestream_id',
    xBannerArea: {
        x: 50,     // X coordinate of X banner
        y: 50,     // Y coordinate of X banner
        width: 1200, // Width of X banner area
        height: 800 // Height of X banner area
    },
    yBannerArea: {
        x: 50,     // X coordinate of Y banner (same as X banner)
        y: 50,     // Y coordinate of Y banner (same as X banner)
        width: 1200, // Width of Y banner area (same as X banner)
        height: 800 // Height of Y banner area (same as X banner)
    },
    ocrArea: {
        x: 50,     // X coordinate of OCR area (same as banner area)
        y: 50,     // Y coordinate of OCR area (same as banner area)
        width: 500, // Increase width to 300 pixels
        height: 150 // Increase height to 200 pixels
    },
    // Simplified configuration for alternating capture
    captureStrategy: {
        xBannerMinute: 4, // Capture X banner at minute 4
        yBannerMinute: 34,  // Capture Y banner at minute 34
        minTimeBetweenCaptures: 30000, // Minimum 30 seconds between captures
        hashCacheSize: 5 // Keep last 5 hashes to avoid duplicates
    },
    ocrSettings: {
        attemptDelayMs: 250,     // Delay between OCR attempts when looping
        roiType: 'jpeg',         // Use JPEG for ROI OCR for speed
        roiQuality: 60           // JPEG quality for ROI screenshots
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
        this.browser = null;
        this.page = null;
        this.isRunning = false;
        this.lastXBannerTime = 0;
        this.lastYBannerTime = 0;
        this.recentHashes = [];
        this.lastCaptureTime = 0;
        this.lastSentBannerNames = { X: null, Y: null }; // Add this for deduplication
        this.tesseractWorker = null;
        this.setupDiscordClient();
    }

    // OCR helper to detect banner name from screenshot (kept for compatibility)
    async ocrBannerName() {
        try {
            const ocrArea = this.config.ocrArea;
            const screenshot = await this.page.screenshot({ clip: ocrArea });
            const { data: { text } } = await Tesseract.recognize(screenshot, 'eng', {
                tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 ',
            });
            const match = text.match(/([XY])\s*BANNER/i);
            return match ? match[0].trim().toUpperCase() : null;
        } catch (error) {
            console.error('OCR error:', error);
            return null;
        }
    }

    // Initialize a persistent Tesseract worker for speed
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
            console.log('⚠️ Could not init Tesseract worker, falling back:', error.message);
            this.tesseractWorker = null;
        }
    }

    // Generic OCR helper: returns recognized text (uppercased) from a given image buffer
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
            console.error('OCR error (ocrTextFromImage):', error);
            return '';
        }
    }

    // Parse helpers for OCR text
    extractBannerLabel(ocrTextUpper) {
        const match = ocrTextUpper.match(/\b([XY])\s*BANNER\b/);
        return match ? match[0] : null; // Returns 'X BANNER' or 'Y BANNER'
    }

    hasFiveStar(ocrTextUpper) {
        return /\b5\s*STAR\b/.test(ocrTextUpper);
    }

    // Capture only a small region for fast OCR (JPEG by default)
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

    // New capture strategy for X and Y banners using OCR
    async captureAndSendBanners() {
        // Reset duplicate hash cache and last sent banner names before capturing banners
        this.recentHashes = [];
        this.lastSentBannerNames = { X: null, Y: null };

        // Make sure OCR worker is ready
        await this.initTesseractWorker();

        // Find X banner until detected
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
                // Grab full banner ASAP
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

        // Find Y banner until detected
        let yAttempts = 0;
        while (true) {
            yAttempts++;
            console.log(`🔎 [Y] Attempt ${yAttempts}: Capturing OCR ROIs...`);
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
            this.startMonitoring();
        });

        this.client.on(Events.MessageCreate, async (message) => {
            if (message.author.bot) return;

            // Manual command to trigger both banners with OCR
            if (message.content === '!capture-banners') {
                // Pause monitoring
                const wasRunning = this.isRunning;
                this.isRunning = false;
                console.log('⏸️ Paused monitoring for !capture-banners command');
                await this.captureAndSendBanners();
                // Resume monitoring if it was running before
                if (wasRunning) {
                    console.log('▶️ Resuming scheduled monitoring after !capture-banners');
                    this.isRunning = true;
                    this.startScheduledMonitoring();
                }
            } else if (message.content === '!test-x') {
                await this.captureXBanner();
            } else if (message.content === '!test-y') {
                await this.captureYBanner();
            } else if (message.content === '!status') {
                await message.reply(`Bot is ${this.isRunning ? 'running' : 'stopped'}`);
            } else if (message.content === '!test-screenshot') {
                await this.testScreenshot();
            } else if (message.content === '!test-capture') {
                console.log('🧪 Manual test capture triggered');
                await this.testScreenshot();
            } else if (message.content === '!start-video') {
                await this.startVideo();
            } else if (message.content === '!check-video') {
                await this.checkVideoStatus(message);
            } else if (message.content === '!restart-browser') {
                await this.restartBrowser();
                await message.reply('🔄 Browser restarted!');
            } else if (message.content === '!skip-ads') {
                console.log('⏩ Manual ad skip triggered');
                await this.skipYouTubeAds();
                await message.reply('⏩ Ad skip attempt completed!');
            } else if (message.content === '!check-ads') {
                await this.checkForAds(message);
            } else if (message.content === '!test-alternating-capture') {
                console.log('🔄 Manual alternating capture test triggered');
                const xResult = await this.captureSingleBanner('X');
                await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds
                const yResult = await this.captureSingleBanner('Y');
                await message.reply(`🔄 Alternating capture test completed!\nX Banner: ${xResult ? '✅ Captured' : '🚫 Not captured'}\nY Banner: ${yResult ? '✅ Captured' : '🚫 Not captured'}`);
            } else if (message.content === '!test-single-capture') {
                console.log('📸 Manual single capture test triggered');
                const result = await this.captureSingleBanner('X');
                await message.reply(`📸 Single capture test completed!\nResult: ${result ? '✅ Captured' : '🚫 Not captured'}`);
            } else if (message.content === '!banner-status') {
                const status = `📊 **Banner Status**\n` +
                    `Last Capture Time: ${this.lastCaptureTime ? new Date(this.lastCaptureTime).toLocaleTimeString() : 'None'}\n` +
                    `Recent Hashes: ${this.recentHashes.length}\n` +
                    `X Banner Last: ${this.lastXBannerTime ? new Date(this.lastXBannerTime).toLocaleTimeString() : 'Never'}\n` +
                    `Y Banner Last: ${this.lastYBannerTime ? new Date(this.lastYBannerTime).toLocaleTimeString() : 'Never'}\n` +
                    `Bot Running: ${this.isRunning ? 'Yes' : 'No'}`;
                await message.reply(status);
            } else if (message.content === '!extension-status') {
                await this.checkExtensionStatus(message);
            } else if (message.content === '!banner-config') {
                await this.checkBannerConfig(message);
            }
        });
    }

    async startMonitoring() {
        try {
            console.log('🚀 Starting browser...');

            // Set up browser with extensions
            const userDataDir = './browser-data';

            // Get absolute path for extension
            const path = await import('path');
            const fs = await import('fs');
            const extensionPath = path.resolve('./extensions/ublock-origin-lite');
            
            // Check if extension directory exists and has manifest
            let extensionArgs = [];
            try {
                if (fs.existsSync(extensionPath) && fs.existsSync(path.join(extensionPath, 'manifest.json'))) {
                    console.log('✅ Extension directory found, attempting to load uBlock Origin Lite');
                    extensionArgs = [`--load-extension=${extensionPath}`];
                } else {
                    console.log('⚠️ Extension directory not found, running without ad blocker');
                }
            } catch (error) {
                console.log('⚠️ Error checking extension directory, running without ad blocker:', error.message);
            }
            
            this.browser = await puppeteer.launch({
                headless: "new",
                userDataDir: userDataDir,
                args: [
                    // Enhanced stealth arguments
                    '--disable-blink-features=AutomationControlled', // Critical for YouTube
                    '--autoplay-policy=no-user-gesture-required',
                    '--disable-web-security',
                    '--disable-features=VizDisplayCompositor',
                    
                    // Performance optimizations
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
                    
                    // Additional stealth and performance
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
                    
                    // Extension args (may be empty if extension not found)
                    ...extensionArgs
                ]
            });

            this.page = await this.browser.newPage();

            // Apply enhanced stealth measures
            await this.applyStealthMeasures();

            // Set a realistic user agent to avoid bot detection
            await this.page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

            // Set viewport size
            await this.page.setViewport({ width: 1920, height: 1080 });

            // Enable uBlock Origin
            await this.enableAdBlocker();

            console.log('📺 Loading livestream...');

            // Try multiple times with different strategies for EC2 compatibility
            let pageLoaded = false;
            let attempts = 0;
            const maxAttempts = 3;

            while (!pageLoaded && attempts < maxAttempts) {
                attempts++;
                console.log(`🔄 Loading attempt ${attempts}/${maxAttempts}...`);

                try {
                    // Use different wait strategies based on attempt number
                    const waitStrategy = attempts === 1 ? 'networkidle2' : 'domcontentloaded';
                    const timeout = attempts === 1 ? 60000 : 90000; // Increase timeout for EC2

                    console.log(`⏱️ Using ${waitStrategy} strategy with ${timeout}ms timeout...`);

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

                        // Try to close any existing page and create a new one
                        try {
                            if (this.page && !this.page.isClosed()) {
                                await this.page.close();
                            }
                            this.page = await this.browser.newPage();
                            await this.applyStealthMeasures();
                            await this.page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
                            await this.page.setViewport({ width: 1920, height: 1080 });
                        } catch (pageError) {
                            console.log('⚠️ Error recreating page:', pageError.message);
                        }
                    } else {
                        throw error; // Re-throw the error if all attempts failed
                    }
                }
            }

            // Check if on the correct page with more lenient validation for EC2
            const currentUrl = this.page.url();
            console.log('📍 Current URL:', currentUrl);
            console.log('🎯 Target URL:', this.config.livestreamUrl);

            // More lenient URL checking for EC2 (sometimes redirects happen)
            const targetUrlBase = this.config.livestreamUrl.split('?')[0];
            const isCorrectPage = currentUrl.includes(targetUrlBase) ||
                currentUrl.includes('youtube.com') ||
                currentUrl.includes('youtu.be');

            if (!isCorrectPage) {
                console.error('❌ Not on the correct livestream page! Current URL:', currentUrl);
                await this.sendErrorToDiscord('Not on the correct livestream page! Please check the livestream URL in the config.');
                return;
            } else {
                console.log('✅ On the correct livestream page.');
            }

            // Check if we're on a YouTube page (more lenient for EC2)
            if (!currentUrl.includes('youtube.com') && !currentUrl.includes('youtu.be')) {
                console.log('⚠️ Not on a YouTube page, but continuing anyway for EC2 compatibility');
                console.log('Current URL:', currentUrl);
            }

            // Handle YouTube consent popup and other overlays with enhanced method
            await this.handleYouTubeOverlaysEnhanced();

            // Start the video with enhanced method
            await this.startVideoEnhanced();

            // Wait for video to load
            await new Promise(resolve => setTimeout(resolve, 5000));

            this.isRunning = true;
            console.log('✅ Monitoring started');

            // Start the scheduled monitoring
            this.startScheduledMonitoring();

        } catch (error) {
            console.error('❌ Failed to start monitoring:', error);

            // More detailed error reporting for EC2 debugging
            let errorMessage = 'Failed to start monitoring: ' + error.message;

            if (error.message.includes('TimeoutError')) {
                errorMessage += '\n\nThis is likely due to slow EC2 performance. The bot will retry automatically.';
                console.log('🔄 Will attempt to restart monitoring in 30 seconds...');

                // Schedule a retry
                setTimeout(() => {
                    console.log('🔄 Retrying monitoring start...');
                    this.startMonitoring();
                }, 30000);

            } else if (error.message.includes('Protocol error')) {
                errorMessage += '\n\nBrowser connection issue. Will restart browser.';
                console.log('🔄 Will restart browser in 10 seconds...');

                setTimeout(() => {
                    console.log('🔄 Restarting browser...');
                    this.restartBrowser();
                }, 10000);
            }

            await this.sendErrorToDiscord(errorMessage);
        }
    }

    // Enhanced stealth measures
    async applyStealthMeasures() {
        try {
            // Remove webdriver property
            await this.page.evaluateOnNewDocument(() => {
                delete navigator.__proto__.webdriver;
                
                // Override the plugins property
                Object.defineProperty(navigator, 'plugins', {
                    get: () => [1, 2, 3, 4, 5],
                });
                
                // Override the languages property
                Object.defineProperty(navigator, 'languages', {
                    get: () => ['en-US', 'en'],
                });
                
                // Override the permissions property
                const originalQuery = window.navigator.permissions.query;
                window.navigator.permissions.query = (parameters) => (
                    parameters.name === 'notifications' ?
                        Promise.resolve({ state: Notification.permission }) :
                        originalQuery(parameters)
                );
                
                // Override the chrome property
                Object.defineProperty(window, 'chrome', {
                    writable: true,
                    enumerable: true,
                    configurable: true,
                    value: {
                        runtime: {},
                    },
                });
                
                // Override the permissions property
                Object.defineProperty(navigator, 'permissions', {
                    get: () => ({
                        query: async () => ({ state: 'granted' }),
                    }),
                });
            });

            // Set additional headers
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

    // Enhanced YouTube overlay handling
    async handleYouTubeOverlaysEnhanced() {
        try {
            console.log('🔧 Handling YouTube overlays with enhanced method...');

            // Check if page and browser are still valid
            if (!this.page || !this.browser || this.page.isClosed()) {
                console.log('⚠️ Page not available, skipping overlay handling');
                return;
            }

            // Wait for overlays to load
            await new Promise(resolve => setTimeout(resolve, 3000));

            try {
                // More sophisticated overlay handling
                await this.page.evaluate(() => {
                    // Remove specific overlay types more carefully
                    const overlaySelectors = [
                        '[role="dialog"]:not([data-video-id])',
                        '.modal:not(.html5-video-player)',
                        '.popup:not(.ytp-player)',
                        '.overlay:not(.ytp-video-container)',
                        '.ytp-popup',
                        '.ytp-pause-overlay',
                        '.ytp-gradient-top',
                        '.ytp-gradient-bottom',
                        // Additional stealth overlays
                        '[class*="consent"]',
                        '[class*="Consent"]',
                        '[class*="cookie"]',
                        '[class*="Cookie"]',
                        '[class*="privacy"]',
                        '[class*="Privacy"]',
                        '[class*="gdpr"]',
                        '[class*="GDPR"]'
                    ];

                    overlaySelectors.forEach(selector => {
                        const overlays = document.querySelectorAll(selector);
                        overlays.forEach(overlay => {
                            // Check if this overlay is related to video player
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

                    // Remove backdrop elements that are not video-related
                    const backdrops = document.querySelectorAll('.backdrop, .modal-backdrop, .overlay-backdrop');
                    backdrops.forEach(backdrop => {
                        if (!backdrop.closest('.html5-video-player') &&
                            !backdrop.closest('.ytp-player')) {
                            backdrop.style.display = 'none';
                        }
                    });

                    // Click consent buttons more intelligently
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

                    // Remove body scroll lock
                    document.body.style.overflow = 'auto';
                    document.documentElement.style.overflow = 'auto';
                    
                    // Remove any fixed positioned overlays
                    const fixedElements = document.querySelectorAll('[style*="position: fixed"]');
                    fixedElements.forEach(el => {
                        const rect = el.getBoundingClientRect();
                        if (rect.width > 200 && rect.height > 100 && 
                            !el.closest('.html5-video-player') &&
                            !el.closest('.ytp-player')) {
                            el.style.display = 'none';
                        }
                    });
                });

                // Wait for changes to take effect
                await new Promise(resolve => setTimeout(resolve, 2000));

                console.log('✅ YouTube overlays handled with enhanced method');

            } catch (error) {
                if (error.message.includes('Protocol error') || error.message.includes('Execution context was destroyed')) {
                    console.log('⚠️ Execution context was destroyed during overlay handling');
                    return;
                }
                throw error;
            }

        } catch (error) {
            console.error('❌ Error handling YouTube overlays:', error);
        }
    }

    // Enhanced video start method
    async startVideoEnhanced() {
        try {
            console.log('▶️ Attempting to start video with enhanced method...');

            // Check if page and browser are still valid
            if (!this.page || !this.browser || this.page.isClosed()) {
                console.log('⚠️ Page not available, skipping video start');
                return;
            }

            try {
                // Wait for a video element to appear (timeout after 10 seconds)
                await this.page.waitForSelector('video', { timeout: 10000 });
                await new Promise(resolve => setTimeout(resolve, 500)); // Let the video load

                // Try to play the video using the video element's play() method
                const played = await this.page.evaluate(async () => {
                    const video = document.querySelector('video');
                    if (video) {
                        try {
                            await video.play();
                            return !video.paused;
                        } catch (e) {
                            // If play() fails (e.g., due to overlay), return false
                            return false;
                        }
                    }
                    return false;
                });

                if (played) {
                    console.log('✅ Video started via video.play()');
                    return;
                }

                // If not playing, try clicking the overlay play button with enhanced selectors
                console.log('🔍 Looking for play buttons with enhanced method...');
                const playButtonSelectors = [
                    '.ytp-large-play-button',
                    '.ytp-play-button',
                    'button[aria-label*="Play"]',
                    'button[aria-label*="play"]',
                    'button[title*="Play"]',
                    'button[title*="play"]',
                    // Additional stealth selectors
                    '[class*="play-button"]',
                    '[class*="PlayButton"]',
                    '[class*="play"]:not([class*="player"])',
                    '[class*="Play"]:not([class*="player"])'
                ];

                for (const selector of playButtonSelectors) {
                    try {
                        // Check if page is still valid before each operation
                        if (this.page.isClosed()) {
                            console.log('⚠️ Page was closed during video start attempt');
                            return;
                        }

                        const button = await this.page.$(selector);
                        if (button) {
                            console.log(`🖱️ Clicking play button: ${selector}`);
                            await button.click();
                            console.log(`✅ Clicked play button: ${selector}`);
                            await new Promise(resolve => setTimeout(resolve, 1500));
                            break;
                        }
                    } catch (error) {
                        if (error.message.includes('Protocol error') || error.message.includes('Execution context was destroyed')) {
                            console.log(`⚠️ Context destroyed while clicking ${selector}, skipping`);
                            return;
                        }
                        console.log(`⚠️ Error with play button ${selector}:`, error.message);
                    }
                }

                // Fallback: click the center of the video area
                const videoBox = await this.page.$('video');
                if (videoBox) {
                    const box = await videoBox.boundingBox();
                    if (box) {
                        await this.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
                        console.log('🖱️ Clicked center of video area');
                        await new Promise(resolve => setTimeout(resolve, 500));
                    }
                }

                console.log('✅ Video start attempt completed with enhanced method');

            } catch (error) {
                if (error.message.includes('Protocol error') || error.message.includes('Execution context was destroyed')) {
                    console.log('⚠️ Execution context was destroyed during video start');
                    return;
                }
                throw error;
            }

        } catch (error) {
            console.error('❌ Error starting video:', error);
        }
    }

    startScheduledMonitoring() {
        if (this._scheduledMonitorActive) return;
        this._scheduledMonitorActive = true;
        console.log('⏰ Scheduled monitoring started...');
        this._scheduledMonitorInterval = setInterval(async () => {
            if (!this.isRunning) return;
            const now = new Date();
            const minute = now.getMinutes();

            // At X or Y banner minute, run the full capture logic
            if (
                minute === this.config.captureStrategy.xBannerMinute ||
                minute === this.config.captureStrategy.yBannerMinute
            ) {
                console.log(`⏰ It's scheduled time (${minute}), running captureAndSendBanners...`);
                await this.captureAndSendBanners();
            }
        }, 60 * 1000); // Check every minute
    }

    async enableAdBlocker() {
        try {
            console.log('🛡️ Setting up ad blocker (uBlock Origin only)...');
            
            // Check if extension loaded successfully
            const targets = await this.browser.targets();
            const extensionTargets = targets.filter(target => target.type() === 'background_page' && target.url().includes('ublock'));
            
            if (extensionTargets.length > 0) {
                console.log('✅ uBlock Origin extension loaded successfully');
            } else {
                console.log('⚠️ uBlock Origin extension not detected, continuing without ad blocker');
                console.log('This is normal if the extension failed to load due to version compatibility');
            }
            
            console.log('✅ Ad blocker setup completed');
        } catch (error) {
            console.error('❌ Failed to enable ad blocker:', error);
            console.log('⚠️ Continuing without ad blocker - this is not critical for bot operation');
        }
    }

    async skipYouTubeAds() {
        try {
            console.log('🔍 Checking for YouTube ads to skip...');

            // Check if page and browser are still valid
            if (!this.page || !this.browser || this.page.isClosed()) {
                console.log('⚠️ Page not available, skipping ad detection');
                return;
            }

            const adInfo = await this.page.evaluate(() => {
                // Comprehensive ad detection selectors
                const adSelectors = [
                    // YouTube video ads
                    '.ytp-ad-skip-button',
                    '.ytp-ad-skip-button-modern',
                    '.ytp-ad-overlay-close-button',
                    '.ytp-ad-feedback-dialog-close-button',
                    '.ytp-ad-feedback-dialog-container',

                    // Display ads
                    '[class*="ytp-ad"]',
                    '[class*="ytpAd"]',
                    '[class*="videoAd"]',
                    '[class*="VideoAd"]',
                    '[class*="displayAd"]',
                    '[class*="DisplayAd"]',

                    // Generic ad selectors
                    '[class*="ad"]:not([class*="load"]):not([class*="add"])',
                    '[class*="Ad"]:not([class*="load"]):not([class*="add"])',
                    '[class*="sponsored"]',
                    '[class*="Sponsored"]',
                    '[class*="promotion"]',
                    '[class*="Promotion"]',
                    '[data-ad]',
                    '[data-ads]',

                    // Overlay ads
                    '.ytp-ad-overlay',
                    '.ytp-ad-overlay-container',
                    '.ytp-ad-overlay-slot',

                    // Ad feedback and controls
                    '.ytp-ad-feedback-dialog',
                    '.ytp-ad-feedback-dialog-container',
                    '.ytp-ad-feedback-dialog-close-button'
                ];

                let foundAds = [];
                let skipButtons = [];
                let adOverlays = [];

                // Check for skip buttons first
                const skipButtonSelectors = [
                    '.ytp-ad-skip-button',
                    '.ytp-ad-skip-button-modern',
                    'button[aria-label*="Skip"]',
                    'button[aria-label*="skip"]',
                    'button[title*="Skip"]',
                    'button[title*="skip"]'
                ];

                skipButtonSelectors.forEach(selector => {
                    const buttons = document.querySelectorAll(selector);
                    buttons.forEach(button => {
                        const rect = button.getBoundingClientRect();
                        if (rect.width > 0 && rect.height > 0 &&
                            rect.top >= 0 && rect.left >= 0 &&
                            rect.bottom <= window.innerHeight && rect.right <= window.innerWidth) {
                            skipButtons.push({
                                selector: selector,
                                text: button.textContent.trim(),
                                visible: true,
                                position: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
                            });
                        }
                    });
                });

                // Check for ad overlays
                adSelectors.forEach(selector => {
                    const ads = document.querySelectorAll(selector);
                    ads.forEach(ad => {
                        const rect = ad.getBoundingClientRect();
                        if (rect.width > 0 && rect.height > 0) {
                            const isVisible = rect.top >= 0 && rect.left >= 0 &&
                                rect.bottom <= window.innerHeight && rect.right <= window.innerWidth;

                            foundAds.push({
                                selector: selector,
                                text: ad.textContent.substring(0, 100).trim(),
                                visible: isVisible,
                                position: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
                            });

                            // Check if it's an overlay that should be closed
                            if (isVisible && (selector.includes('overlay') || selector.includes('dialog'))) {
                                adOverlays.push({
                                    selector: selector,
                                    text: ad.textContent.substring(0, 50).trim(),
                                    position: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
                                });
                            }
                        }
                    });
                });

                // Check for ad-related text in buttons
                const allButtons = document.querySelectorAll('button');
                const adButtons = Array.from(allButtons).filter(button => {
                    const buttonText = button.textContent.toLowerCase();
                    const adKeywords = ['skip', 'ad', 'sponsored', 'learn more', 'visit', 'close', 'x'];
                    return adKeywords.some(keyword => buttonText.includes(keyword));
                });

                adButtons.forEach(button => {
                    const rect = button.getBoundingClientRect();
                    if (rect.width > 0 && rect.height > 0) {
                        const isVisible = rect.top >= 0 && rect.left >= 0 &&
                            rect.bottom <= window.innerHeight && rect.right <= window.innerWidth;

                        if (isVisible && !skipButtons.some(sb => sb.selector === button.tagName.toLowerCase())) {
                            skipButtons.push({
                                selector: 'button[ad-related]',
                                text: button.textContent.trim(),
                                visible: true,
                                position: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
                            });
                        }
                    }
                });

                return {
                    skipButtons: skipButtons,
                    adOverlays: adOverlays,
                    allAds: foundAds,
                    hasSkipButtons: skipButtons.length > 0,
                    hasAdOverlays: adOverlays.length > 0,
                    hasAds: foundAds.length > 0
                };
            });

            // Handle skip buttons
            if (adInfo.hasSkipButtons) {
                console.log(`⏩ Found ${adInfo.skipButtons.length} skip button(s)`);

                for (const skipButton of adInfo.skipButtons) {
                    try {
                        const button = await this.page.$(skipButton.selector);
                        if (button) {
                            console.log(`🖱️ Clicking skip button: "${skipButton.text}"`);
                            await button.click();
                            console.log('✅ Skip button clicked successfully');

                            // Wait for ad to disappear
                            await new Promise(resolve => setTimeout(resolve, 1500));

                            // Check if ad is still there
                            const stillHasAds = await this.page.evaluate(() => {
                                return document.querySelector('.ytp-ad-skip-button, .ytp-ad-skip-button-modern') !== null;
                            });

                            if (!stillHasAds) {
                                console.log('✅ Ad successfully skipped');
                                break;
                            }
                        }
                    } catch (error) {
                        console.log(`⚠️ Error clicking skip button: ${error.message}`);
                    }
                }
            }

            // Handle ad overlays
            if (adInfo.hasAdOverlays) {
                console.log(`🚫 Found ${adInfo.adOverlays.length} ad overlay(s) to close`);

                for (const overlay of adInfo.adOverlays) {
                    try {
                        // Try to find and click close buttons in overlays
                        const closeButtons = await this.page.$$(`${overlay.selector} button, ${overlay.selector} [aria-label*="Close"], ${overlay.selector} [aria-label*="close"]`);

                        for (const closeButton of closeButtons) {
                            try {
                                await closeButton.click();
                                console.log(`✅ Closed ad overlay: "${overlay.text}"`);
                                await new Promise(resolve => setTimeout(resolve, 500));
                            } catch (error) {
                                console.log(`⚠️ Error closing overlay: ${error.message}`);
                            }
                        }
                    } catch (error) {
                        console.log(`⚠️ Error handling overlay: ${error.message}`);
                    }
                }
            }

            // Report results
            if (adInfo.hasAds) {
                console.log(`📊 Ad detection summary: ${adInfo.allAds.length} ad elements found`);
                if (adInfo.hasSkipButtons) {
                    console.log(`⏩ ${adInfo.skipButtons.length} skip button(s) processed`);
                }
                if (adInfo.hasAdOverlays) {
                    console.log(`🚫 ${adInfo.adOverlays.length} overlay(s) processed`);
                }
            } else {
                console.log('✅ No ads detected');
            }

        } catch (error) {
            if (error.message.includes('Protocol error') || error.message.includes('Execution context was destroyed')) {
                console.log('⚠️ Execution context was destroyed during ad skipping');
                return;
            }
            console.error('❌ Error in skipYouTubeAds:', error);
        }
    }

    async checkForAds(message) {
        try {
            if (!this.page || this.page.isClosed()) {
                await message.reply('❌ Page is not available');
                return;
            }

            const adInfo = await this.page.evaluate(() => {
                const adSelectors = [
                    '.ytp-ad-skip-button',
                    '.ytp-ad-skip-button-modern',
                    '.ytp-ad-overlay',
                    '[class*="ytp-ad"]',
                    '[class*="ad"]:not([class*="load"]):not([class*="add"])',
                    '[class*="sponsored"]',
                    '[data-ad]',
                    '[data-ads]'
                ];

                let foundAds = [];
                adSelectors.forEach(selector => {
                    const ads = document.querySelectorAll(selector);
                    ads.forEach(ad => {
                        const rect = ad.getBoundingClientRect();
                        if (rect.width > 0 && rect.height > 0) {
                            foundAds.push({
                                selector: selector,
                                text: ad.textContent.substring(0, 50),
                                visible: rect.top >= 0 && rect.left >= 0 &&
                                    rect.bottom <= window.innerHeight && rect.right <= window.innerWidth,
                                position: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
                            });
                        }
                    });
                });

                return {
                    adElements: foundAds,
                    hasAds: foundAds.length > 0,
                    visibleAds: foundAds.filter(ad => ad.visible).length
                };
            });

            let statusMessage = `🛡️ **Ad Detection Results:**\n`;
            statusMessage += `• Total ads detected: ${adInfo.adElements.length}\n`;
            statusMessage += `• Visible ads: ${adInfo.visibleAds}\n`;
            statusMessage += `• Has ads: ${adInfo.hasAds ? '❌ Yes' : '✅ No'}\n`;

            if (adInfo.adElements.length > 0) {
                statusMessage += `\n**Ad Details:**\n`;
                adInfo.adElements.slice(0, 5).forEach((ad, index) => {
                    statusMessage += `${index + 1}. ${ad.selector} - "${ad.text}" ${ad.visible ? '(Visible)' : '(Hidden)'}\n`;
                });
            }

            await message.reply(statusMessage);
        } catch (error) {
            console.error('❌ Error checking for ads:', error);
            await message.reply('❌ Error checking for ads: ' + error.message);
        }
    }



    async handleYouTubeOverlays() {
        try {
            console.log('🔧 Handling YouTube overlays...');

            // Check if page and browser are still valid
            if (!this.page || !this.browser) {
                console.log('⚠️ Page or browser not available, skipping overlay handling');
                return;
            }

            // Check if page is still attached to browser
            if (this.page.isClosed()) {
                console.log('⚠️ Page is closed, skipping overlay handling');
                return;
            }

            // Wait for overlays to load
            await new Promise(resolve => setTimeout(resolve, 2000));

            try {
                // More targeted popup handling - avoid affecting video elements
                await this.page.evaluate(() => {
                    // Only remove specific overlay types, not all overlays
                    const overlaySelectors = [
                        '[role="dialog"]:not([data-video-id])', // Exclude video-related dialogs
                        '.modal:not(.html5-video-player)',
                        '.popup:not(.ytp-player)',
                        '.overlay:not(.ytp-video-container)',
                        '.ytp-popup',
                        '.ytp-pause-overlay',
                        '.ytp-gradient-top',
                        '.ytp-gradient-bottom'
                    ];

                    overlaySelectors.forEach(selector => {
                        const overlays = document.querySelectorAll(selector);
                        overlays.forEach(overlay => {
                            // Check if this overlay is related to video player
                            if (!overlay.closest('.html5-video-player') &&
                                !overlay.closest('.ytp-player') &&
                                !overlay.closest('video')) {
                                overlay.style.display = 'none';
                                overlay.style.visibility = 'hidden';
                                overlay.style.opacity = '0';
                            }
                        });
                    });

                    // Remove backdrop elements that are not video-related
                    const backdrops = document.querySelectorAll('.backdrop, .modal-backdrop, .overlay-backdrop');
                    backdrops.forEach(backdrop => {
                        if (!backdrop.closest('.html5-video-player') &&
                            !backdrop.closest('.ytp-player')) {
                            backdrop.style.display = 'none';
                        }
                    });

                    // Click consent buttons more carefully
                    const buttons = document.querySelectorAll('button');
                    buttons.forEach(button => {
                        const text = button.textContent.toLowerCase();
                        if ((text.includes('accept') || text.includes('agree') || text.includes('continue') || text.includes('ok')) &&
                            !button.closest('.html5-video-player') &&
                            !button.closest('.ytp-player')) {
                            button.click();
                        }
                    });

                    // Remove body scroll lock
                    document.body.style.overflow = 'auto';
                    document.documentElement.style.overflow = 'auto';
                });

                // Wait for changes to take effect
                await new Promise(resolve => setTimeout(resolve, 1000));

                console.log('✅ YouTube overlays handled carefully');

            } catch (error) {
                if (error.message.includes('Protocol error') || error.message.includes('Execution context was destroyed')) {
                    console.log('⚠️ Execution context was destroyed during overlay handling');
                    return;
                }
                throw error;
            }

        } catch (error) {
            console.error('❌ Error handling YouTube overlays:', error);
        }
    }

    async startVideo() {
        try {
            console.log('▶️ Attempting to start video...');

            // Check if page and browser are still valid
            if (!this.page || !this.browser) {
                console.log('⚠️ Page or browser not available, skipping video start');
                return;
            }

            // Check if page is still attached to browser
            if (this.page.isClosed()) {
                console.log('⚠️ Page is closed, skipping video start');
                return;
            }

            try {
                // Wait for a video element to appear (timeout after 5 seconds)
                await this.page.waitForSelector('video', { timeout: 5000 });
                await new Promise(resolve => setTimeout(resolve, 300)); // Let the video load

                // Try to play the video using the video element's play() method
                const played = await this.page.evaluate(async () => {
                    const video = document.querySelector('video');
                    if (video) {
                        try {
                            await video.play();
                            return !video.paused;
                        } catch (e) {
                            // If play() fails (e.g., due to overlay), return false
                            return false;
                        }
                    }
                    return false;
                });

                if (played) {
                    console.log('✅ Video started via video.play()');
                    return;
                }

                // If not playing, try clicking the overlay play button
                console.log('🔍 Looking for play buttons...');
                const playButtonSelectors = [
                    '.ytp-large-play-button', // YouTube's big play button
                    '.ytp-play-button',
                    'button[aria-label*="Play"]',
                    'button[aria-label*="play"]'
                ];

                for (const selector of playButtonSelectors) {
                    try {
                        // Check if page is still valid before each operation
                        if (this.page.isClosed()) {
                            console.log('⚠️ Page was closed during video start attempt');
                            return;
                        }

                        const button = await this.page.$(selector);
                        if (button) {
                            console.log(`🖱️ Clicking play button: ${selector}`);
                            await button.click();
                            console.log(`✅ Clicked play button: ${selector}`);
                            await new Promise(resolve => setTimeout(resolve, 1000));
                            break;
                        }
                    } catch (error) {
                        if (error.message.includes('Protocol error') || error.message.includes('Execution context was destroyed')) {
                            console.log(`⚠️ Context destroyed while clicking ${selector}, skipping`);
                            return;
                        }
                        console.log(`⚠️ Error with play button ${selector}:`, error.message);
                    }
                }

                // Fallback: click the center of the video area
                const videoBox = await this.page.$('video');
                if (videoBox) {
                    const box = await videoBox.boundingBox();
                    if (box) {
                        await this.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
                        console.log('🖱️ Clicked center of video area');
                        await new Promise(resolve => setTimeout(resolve, 300));
                    }
                }

                console.log('✅ Video start attempt completed');

            } catch (error) {
                if (error.message.includes('Protocol error') || error.message.includes('Execution context was destroyed')) {
                    console.log('⚠️ Execution context was destroyed during video start');
                    return;
                }
                throw error;
            }

        } catch (error) {
            console.error('❌ Error starting video:', error);
        }
    }

    async checkVideoStatus(message) {
        try {
            if (!this.page || this.page.isClosed()) {
                await message.reply('❌ Page is not available');
                return;
            }

            const videoStatus = await this.page.evaluate(() => {
                const video = document.querySelector('video');
                if (!video) {
                    return { exists: false, playing: false, paused: false, currentTime: 0, duration: 0 };
                }

                return {
                    exists: true,
                    playing: !video.paused,
                    paused: video.paused,
                    currentTime: video.currentTime,
                    duration: video.duration,
                    readyState: video.readyState
                };
            });

            let statusMessage = `📺 **Video Status:**\n`;
            statusMessage += `• Video element exists: ${videoStatus.exists ? '✅ Yes' : '❌ No'}\n`;

            if (videoStatus.exists) {
                statusMessage += `• Video playing: ${videoStatus.playing ? '✅ Yes' : '❌ No'}\n`;
                statusMessage += `• Video paused: ${videoStatus.paused ? '❌ Yes' : '✅ No'}\n`;
                statusMessage += `• Current time: ${videoStatus.currentTime.toFixed(2)}s\n`;
                statusMessage += `• Duration: ${videoStatus.duration.toFixed(2)}s\n`;
                statusMessage += `• Ready state: ${videoStatus.readyState}\n`;
            }

            await message.reply(statusMessage);
        } catch (error) {
            console.error('❌ Error checking video status:', error);
            await message.reply('❌ Error checking video status: ' + error.message);
        }
    }

    // New methods for banner change detection
    async captureBannerScreenshot(area) {
        try {
            const screenshot = await this.page.screenshot({
                clip: {
                    x: area.x,
                    y: area.y,
                    width: area.width,
                    height: area.height
                }
            });
            return screenshot;
        } catch (error) {
            console.error('❌ Failed to capture banner screenshot:', error);
            return null;
        }
    }

    calculateImageHash(imageBuffer) {
        try {
            // Create a simple hash based on image data
            // This is a basic implementation - for production, consider using perceptual hashing
            const hash = crypto.createHash('md5').update(imageBuffer).digest('hex');
            return hash;
        } catch (error) {
            console.error('❌ Error calculating image hash:', error);
            return null;
        }
    }



    isDuplicateImage(imageBuffer) {
        try {
            const currentHash = this.calculateImageHash(imageBuffer);
            if (!currentHash) return false;

            // Check if this hash exists in recent hashes
            if (this.recentHashes.includes(currentHash)) {
                console.log('🚫 Duplicate image detected, skipping...');
                return true;
            }

            // Add to recent hashes and maintain cache size
            this.recentHashes.push(currentHash);
            if (this.recentHashes.length > this.config.captureStrategy.hashCacheSize) {
                this.recentHashes.shift(); // Remove oldest hash
            }

            return false;
        } catch (error) {
            console.error('❌ Error checking for duplicate image:', error);
            return false;
        }
    }

    async captureSingleBanner(bannerType) {
        try {
            console.log(`📸 Capturing ${bannerType} Banner...`);

            // Check if enough time has passed since last capture
            const timeSinceLastCapture = Date.now() - this.lastCaptureTime;
            if (timeSinceLastCapture < this.config.captureStrategy.minTimeBetweenCaptures) {
                console.log(`⏳ Too soon since last capture (${Math.round(timeSinceLastCapture / 1000)}s), skipping...`);
                return false;
            }

            // Refresh page first to ensure latest content
            console.log('🔄 Refreshing page before capture...');
            await this.refreshPage();

            // Clear overlays and skip ads
            await this.clearOverlaysBeforeCapture();
            await this.skipYouTubeAds();

            const area = bannerType === 'X' ? this.config.xBannerArea : this.config.yBannerArea;
            const screenshot = await this.captureBannerScreenshot(area);

            if (!screenshot) {
                throw new Error('Failed to capture screenshot');
            }

            // Check for duplicates
            if (this.isDuplicateImage(screenshot)) {
                console.log(`🚫 ${bannerType} banner is duplicate, not sending...`);
                await this.sendToDiscord(null, `${bannerType} Banner Duplicate`, `🚫 ${bannerType} Banner is duplicate, skipping...`);
                return false;
            }

            // Send the banner
            console.log(`✅ Captured and sending ${bannerType} banner`);
            if (bannerType === 'Y') {
                // Y banner: send screenshot only, no message
                await this.sendToDiscord(screenshot, `${bannerType} Banner Update`, '', false);
            } else {
                // X banner: send with custom message only
                await this.sendToDiscord(screenshot, `${bannerType} Banner Update`, '');
            }

            // Update timestamps
            this.lastCaptureTime = Date.now();
            if (bannerType === 'X') {
                this.lastXBannerTime = Date.now();
            } else {
                this.lastYBannerTime = Date.now();
            }

            return true;
        } catch (error) {
            console.error(`❌ Failed to capture ${bannerType} banner:`, error);
            await this.sendErrorToDiscord(`Failed to capture ${bannerType} banner: ${error.message}`);
            return false;
        }
    }

    async monitorLoop() {
        if (this._monitorLoopRunning) return; // Prevent multiple loops
        this._monitorLoopRunning = true;
        console.log('🔄 Starting monitoring loop with enhanced health checking...');
        
        let healthCheckCounter = 0;
        const HEALTH_CHECK_INTERVAL = 6; // Check every 6 iterations (60 seconds)
        
        while (this.isRunning) {
            try {
                // Periodic health check
                healthCheckCounter++;
                if (healthCheckCounter >= HEALTH_CHECK_INTERVAL) {
                    console.log('🏥 Performing periodic health check...');
                    const healthStatus = await this.performHealthCheck();
                    
                    if (!healthStatus.isHealthy) {
                        console.log('⚠️ Health check failed, attempting recovery...');
                        await this.performRecovery(healthStatus.issues);
                        healthCheckCounter = 0; // Reset counter after recovery
                        continue; // Skip this iteration and try again
                    }
                    
                    healthCheckCounter = 0; // Reset counter
                    console.log('✅ Health check passed');
                }
                
                // Check for YouTube errors before attempting to capture banners
                const hasError = await this.checkForYouTubeError();
                if (hasError) {
                    console.log('⚠️ YouTube error detected, attempting to refresh page...');
                    await this.sendErrorToDiscord('YouTube error detected: "Something went wrong". Attempting to refresh page...');
                    await this.refreshPage();
                    // Wait a bit longer after refresh to let the page stabilize
                    await new Promise(resolve => setTimeout(resolve, 15000));
                    continue; // Skip this iteration and try again
                }

                await this.captureAndSendBanners();
                await new Promise(resolve => setTimeout(resolve, 10000)); // Wait 10 seconds
            } catch (error) {
                console.error('❌ Error in monitoring loop:', error);
                if (error.message.includes('Protocol error') || error.message.includes('Execution context was destroyed')) {
                    console.log('⚠️ Execution context destroyed, attempting to restart browser...');
                    await this.restartBrowser();
                } else {
                    await new Promise(resolve => setTimeout(resolve, 5000));
                }
            }
        }
    }

    // Enhanced health check method
    async performHealthCheck() {
        try {
            const issues = [];
            
            // Check if browser and page are still valid
            if (!this.browser || !this.page || this.page.isClosed()) {
                issues.push('Browser or page not available');
            }
            
            // Check if we're still on a YouTube page
            try {
                const currentUrl = this.page.url();
                if (!currentUrl.includes('youtube.com') && !currentUrl.includes('youtu.be')) {
                    issues.push('Not on YouTube page');
                }
            } catch (error) {
                issues.push('Cannot access page URL');
            }
            
            // Check if video element exists and is working
            try {
                const videoStatus = await this.page.evaluate(() => {
                    const video = document.querySelector('video');
                    if (!video) return { exists: false, working: false };
                    
                    return {
                        exists: true,
                        working: !video.paused || video.readyState >= 2,
                        readyState: video.readyState,
                        paused: video.paused
                    };
                });
                
                if (!videoStatus.exists) {
                    issues.push('Video element not found');
                } else if (!videoStatus.working) {
                    issues.push('Video not working properly');
                }
            } catch (error) {
                issues.push('Cannot check video status');
            }
            
            // Check for common error pages
            try {
                const hasError = await this.checkForYouTubeError();
                if (hasError) {
                    issues.push('YouTube error page detected');
                }
            } catch (error) {
                issues.push('Cannot check for errors');
            }
            
            return {
                isHealthy: issues.length === 0,
                issues: issues
            };
            
        } catch (error) {
            console.error('❌ Error during health check:', error);
            return {
                isHealthy: false,
                issues: ['Health check failed: ' + error.message]
            };
        }
    }

    // Enhanced recovery method
    async performRecovery(issues) {
        try {
            console.log('🔄 Starting recovery process...');
            console.log('📋 Issues detected:', issues.join(', '));
            
            // Try different recovery strategies based on issues
            if (issues.some(issue => issue.includes('YouTube error page'))) {
                console.log('🔄 Attempting page refresh...');
                await this.refreshPage();
            }
            
            if (issues.some(issue => issue.includes('Video element not found') || issue.includes('Video not working'))) {
                console.log('🔄 Attempting to restart video...');
                await this.startVideoEnhanced();
            }
            
            if (issues.some(issue => issue.includes('Not on YouTube page'))) {
                console.log('🔄 Attempting to navigate back to livestream...');
                await this.page.goto(this.config.livestreamUrl, { 
                    waitUntil: 'domcontentloaded', 
                    timeout: 30000 
                });
                await this.handleYouTubeOverlaysEnhanced();
                await this.startVideoEnhanced();
            }
            
            // If browser/page issues, restart browser
            if (issues.some(issue => issue.includes('Browser or page not available'))) {
                console.log('🔄 Restarting browser...');
                await this.restartBrowser();
            }
            
            // Wait for recovery to take effect
            await new Promise(resolve => setTimeout(resolve, 10000));
            
            console.log('✅ Recovery process completed');
            
        } catch (error) {
            console.error('❌ Error during recovery:', error);
            await this.sendErrorToDiscord('Recovery failed: ' + error.message);
        }
    }

    async checkForYouTubeError() {
        try {
            const isErrorPage = await this.page.evaluate(() => {
                // Check for common YouTube error messages
                const errorSelectors = [
                    'div[class*="error"]',
                    'div[class*="Error"]',
                    'div[class*="problem"]',
                    'div[class*="Problem"]',
                    'div[class*="wrong"]',
                    'div[class*="Wrong"]',
                    'div[class*="sorry"]',
                    'div[class*="Sorry"]',
                    'div[class*="unavailable"]',
                    'div[class*="Unavailable"]'
                ];

                // Check if any error elements exist
                for (const selector of errorSelectors) {
                    const elements = document.querySelectorAll(selector);
                    for (const element of elements) {
                        const text = element.textContent.toLowerCase();
                        if (text.includes('something went wrong') ||
                            text.includes('something\'s wrong') ||
                            text.includes('sorry') ||
                            text.includes('error') ||
                            text.includes('problem') ||
                            text.includes('unavailable') ||
                            text.includes('try again')) {
                            return true;
                        }
                    }
                }

                // Check for specific error text in the page
                const bodyText = document.body.textContent.toLowerCase();
                if (bodyText.includes('something went wrong') ||
                    bodyText.includes('something\'s wrong') ||
                    bodyText.includes('sorry, something went wrong') ||
                    bodyText.includes('error occurred') ||
                    bodyText.includes('try again later')) {
                    return true;
                }

                return false;
            });

            return isErrorPage;
        } catch (error) {
            console.error('❌ Error checking for YouTube error:', error);
            return false;
        }
    }

    async refreshPage() {
        try {
            console.log('🔄 Refreshing page...');

            // Check if page and browser are still valid
            if (!this.page || !this.browser) {
                console.log('⚠️ Page or browser not available, cannot refresh');
                return;
            }

            // Check if page is still attached to browser
            if (this.page.isClosed()) {
                console.log('⚠️ Page is closed, cannot refresh');
                return;
            }

            try {
                // Refresh the page with faster timeout
                await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 8000 });

                // Wait less for page to load
                await new Promise(resolve => setTimeout(resolve, 2000));

                // Handle overlays again
                await this.handleYouTubeOverlays();

                // Try to start video again
                await this.startVideo();

                console.log('✅ Page refreshed successfully');

            } catch (error) {
                if (error.message.includes('Protocol error') || error.message.includes('Execution context was destroyed')) {
                    console.log('⚠️ Execution context was destroyed during page refresh');
                    return;
                }
                throw error;
            }

        } catch (error) {
            console.error('❌ Failed to refresh page:', error);
            await this.sendErrorToDiscord('Failed to refresh page: ' + error.message);
        }
    }

    async clearOverlaysBeforeCapture() {
        try {
            // Check if page and browser are still valid
            if (!this.page || !this.browser || this.page.isClosed()) {
                console.log('⚠️ Page not available, skipping overlay clearing');
                return;
            }

            try {
                // More aggressive overlay clearing before capture
                await this.page.evaluate(() => {
                    // Hide all possible overlays
                    const selectors = [
                        '[role="dialog"]', '.modal', '.popup', '.overlay',
                        '.ytp-popup', '.ytp-pause-overlay', '.ytp-gradient-top',
                        '.ytp-gradient-bottom', '.backdrop', '.modal-backdrop',
                        '.overlay-backdrop', '.ytp-chrome-top', '.ytp-chrome-bottom'
                    ];

                    selectors.forEach(selector => {
                        const elements = document.querySelectorAll(selector);
                        elements.forEach(el => {
                            el.style.display = 'none';
                            el.style.visibility = 'hidden';
                            el.style.opacity = '0';
                            el.style.pointerEvents = 'none';
                        });
                    });

                    // Remove any fixed positioned elements that might be overlays
                    const fixedElements = document.querySelectorAll('[style*="position: fixed"]');
                    fixedElements.forEach(el => {
                        const rect = el.getBoundingClientRect();
                        // If it's covering a large area, hide it
                        if (rect.width > 200 && rect.height > 100) {
                            el.style.display = 'none';
                        }
                    });

                    // Ensure body is scrollable
                    document.body.style.overflow = 'auto';
                    document.documentElement.style.overflow = 'auto';
                });

                // Wait less for overlays to close
                await new Promise(resolve => setTimeout(resolve, 500));

            } catch (error) {
                if (error.message.includes('Protocol error') || error.message.includes('Execution context was destroyed')) {
                    console.log('⚠️ Execution context was destroyed during overlay clearing');
                    return;
                }
                throw error;
            }

        } catch (error) {
            console.log('Could not clear overlays:', error.message);
        }
    }

    async captureXBanner() {
        try {
            console.log('📸 Capturing X Banner...');
            console.log(`📍 X Banner area: x=${this.config.xBannerArea.x}, y=${this.config.xBannerArea.y}, w=${this.config.xBannerArea.width}, h=${this.config.xBannerArea.height}`);

            // Refresh page first to ensure latest content
            console.log('🔄 Refreshing page before capture...');
            await this.refreshPage();

            // Clear any overlays before capturing
            await this.clearOverlaysBeforeCapture();
            // Try to skip ads
            await this.skipYouTubeAds();

            // Check if the area is visible
            const isVisible = await this.page.evaluate((area) => {
                const element = document.elementFromPoint(area.x + area.width / 2, area.y + area.height / 2);
                return element !== null;
            }, this.config.xBannerArea);

            console.log(`👁️ Area visibility check: ${isVisible ? 'Visible' : 'Not visible'}`);

            const screenshot = await this.page.screenshot({
                clip: {
                    x: this.config.xBannerArea.x,
                    y: this.config.xBannerArea.y,
                    width: this.config.xBannerArea.width,
                    height: this.config.xBannerArea.height
                }
            });

            await this.sendToDiscord(screenshot, 'X Banner Update', '');

        } catch (error) {
            console.error('❌ Failed to capture X banner:', error);
            await this.sendErrorToDiscord('Failed to capture X banner: ' + error.message);
        }
    }

    async captureYBanner() {
        try {
            console.log('📸 Capturing Y Banner...');
            console.log(`📍 Y Banner area: x=${this.config.yBannerArea.x}, y=${this.config.yBannerArea.y}, w=${this.config.yBannerArea.width}, h=${this.config.yBannerArea.height}`);

            // Refresh page first to ensure latest content
            console.log('🔄 Refreshing page before capture...');
            await this.refreshPage();

            // Clear any overlays before capturing
            await this.clearOverlaysBeforeCapture();
            // Try to skip ads
            await this.skipYouTubeAds();

            // Check if the area is visible
            const isVisible = await this.page.evaluate((area) => {
                const element = document.elementFromPoint(area.x + area.width / 2, area.y + area.height / 2);
                return element !== null;
            }, this.config.yBannerArea);

            console.log(`👁️ Area visibility check: ${isVisible ? 'Visible' : 'Not visible'}`);

            const screenshot = await this.page.screenshot({
                clip: {
                    x: this.config.yBannerArea.x,
                    y: this.config.yBannerArea.y,
                    width: this.config.yBannerArea.width,
                    height: this.config.yBannerArea.height
                }
            });

            await this.sendToDiscord(screenshot, 'Y Banner Update', '', false);

        } catch (error) {
            console.error('❌ Failed to capture Y banner:', error);
            await this.sendErrorToDiscord('Failed to capture Y banner: ' + error.message);
        }
    }

    // Read banner message from text file
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
                // Read custom message from text file
                const customMessage = this.readBannerMessage();
                
                // Create role ping if role ID is configured
                const rolePing = this.config.roleId && this.config.roleId !== 'your_role_id_here' 
                    ? `<@&${this.config.roleId}>` 
                    : '';

                fullMessage = `${rolePing} ${customMessage}\n${message}\n`.trim();
            } else {
                // Only send the screenshot without any text message
                fullMessage = '';
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

    async testScreenshot() {
        try {
            console.log('⏸️ Pausing monitoring for test capture...');
            const wasRunning = this.isRunning;
            this.isRunning = false;

            console.log('🔄 Reloading page before test capture...');

            // Reload the page first
            await this.refreshPage();

            console.log('📸 Taking test screenshots like main capture functions...');

            // Clear any overlays before capturing (like main functions)
            await this.clearOverlaysBeforeCapture();
            // Try to skip ads (like main functions)
            await this.skipYouTubeAds();

            // Check if X Banner area is visible (like main functions)
            const xBannerVisible = await this.page.evaluate((area) => {
                const element = document.elementFromPoint(area.x + area.width / 2, area.y + area.height / 2);
                return element !== null;
            }, this.config.xBannerArea);

            console.log(`👁️ X Banner area visibility check: ${xBannerVisible ? 'Visible' : 'Not visible'}`);

            // Take X Banner screenshot (like main functions)
            const xBannerScreenshot = await this.page.screenshot({
                clip: {
                    x: this.config.xBannerArea.x,
                    y: this.config.xBannerArea.y,
                    width: this.config.xBannerArea.width,
                    height: this.config.xBannerArea.height
                },
                path: './x-banner-area.png'
            });

            // Send X Banner screenshot to Discord
            await this.sendToDiscord(xBannerScreenshot, 'Test X Banner', `🧪 Test capture - X Banner area (${xBannerVisible ? 'Visible' : 'Not visible'})`);

            console.log('⏳ Waiting 20 seconds before capturing Y Banner...');
            await new Promise(resolve => setTimeout(resolve, 20000));

            // Check if Y Banner area is visible (like main functions)
            const yBannerVisible = await this.page.evaluate((area) => {
                const element = document.elementFromPoint(area.x + area.width / 2, area.y + area.height / 2);
                return element !== null;
            }, this.config.yBannerArea);

            console.log(`👁️ Y Banner area visibility check: ${yBannerVisible ? 'Visible' : 'Not vis18le'}`);

            // Take Y Banner screenshot (like main functions)
            const yBannerScreenshot = await this.page.screenshot({
                clip: {
                    x: this.config.yBannerArea.x,
                    y: this.config.yBannerArea.y,
                    width: this.config.yBannerArea.width,
                    height: this.config.yBannerArea.height
                },
                path: './y-banner-area.png'
            });

            // Send Y Banner screenshot to Discord (screenshot only, no message)
            await this.sendToDiscord(yBannerScreenshot, 'Test Y Banner', '', false);

            console.log('✅ Both banner test screenshots captured and sent to Discord!');

            // Resume monitoring if it was running before
            if (wasRunning) {
                console.log('▶️ Resuming monitoring...');
                this.isRunning = true;
                this.monitorLoop();
            }

        } catch (error) {
            console.error('❌ Failed to take test screenshot:', error);

            // Resume monitoring even if there was an error
            if (wasRunning) {
                console.log('▶️ Resuming monitoring after error...');
                this.isRunning = true;
                this.monitorLoop();
            }
        }
    }

    isBrowserContextValid() {
        try {
            return this.browser &&
                this.page &&
                !this.page.isClosed() &&
                this.browser.isConnected();
        } catch (error) {
            return false;
        }
    }

    async restartBrowser() {
        try {
            console.log('🔄 Restarting browser...');

            // Close existing browser if it exists
            if (this.browser) {
                try {
                    await this.browser.close();
                } catch (error) {
                    console.log('⚠️ Error closing browser:', error.message);
                }
                this.browser = null;
                this.page = null;
            }

            // Wait a moment before restarting
            await new Promise(resolve => setTimeout(resolve, 2000));

            // Restart browser
            await this.startMonitoring();

        } catch (error) {
            console.error('❌ Failed to restart browser:', error);
            await this.sendErrorToDiscord('Failed to restart browser: ' + error.message);
        }
    }

    async checkExtensionStatus(message) {
        try {
            const fs = await import('fs');
            const path = await import('path');
            
            const extensionDir = './extensions/ublock-origin-lite';
            const manifestPath = path.join(extensionDir, 'manifest.json');
            
            let statusMessage = '🛡️ **Extension Status:**\n';
            
            // Check if extension directory exists
            if (!fs.existsSync(extensionDir)) {
                statusMessage += '❌ Extension directory not found\n';
                statusMessage += '📁 Expected: ./extensions/ublock-origin-lite/\n';
                statusMessage += '💡 Run: `npm run setup-adblocker` to get instructions\n';
            } else {
                statusMessage += '✅ Extension directory found\n';
                
                // Check if manifest exists
                if (!fs.existsSync(manifestPath)) {
                    statusMessage += '❌ manifest.json not found\n';
                    statusMessage += '📄 Expected: ./extensions/ublock-origin-lite/manifest.json\n';
                } else {
                    statusMessage += '✅ manifest.json found\n';
                    
                    // Read manifest info
                    try {
                        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
                        statusMessage += `📦 Version: ${manifest.version}\n`;
                        statusMessage += `📦 Name: ${manifest.name}\n`;
                        statusMessage += `📦 Min Chrome: ${manifest.minimum_chrome_version || 'Not specified'}\n`;
                    } catch (error) {
                        statusMessage += `❌ Error reading manifest: ${error.message}\n`;
                    }
                }
            }
            
            // Check if browser is running and extension is loaded
            if (this.browser) {
                try {
                    const targets = await this.browser.targets();
                    const extensionTargets = targets.filter(target => 
                        target.type() === 'background_page' && 
                        target.url().includes('ublock')
                    );
                    
                    if (extensionTargets.length > 0) {
                        statusMessage += '✅ Extension loaded in browser\n';
                    } else {
                        statusMessage += '⚠️ Extension not detected in browser\n';
                        statusMessage += '💡 This may be due to version incompatibility\n';
                    }
                } catch (error) {
                    statusMessage += `❌ Error checking browser targets: ${error.message}\n`;
                }
            } else {
                statusMessage += '⚠️ Browser not running\n';
            }
            
            await message.reply(statusMessage);
            
        } catch (error) {
            console.error('❌ Error checking extension status:', error);
            await message.reply('❌ Error checking extension status: ' + error.message);
        }
    }

    async checkBannerConfig(message) {
        try {
            console.log('🔍 Checking banner configuration...');
            
            let status = '📋 **Banner Configuration Status**\n\n';
            
            // Check role configuration
            if (this.config.roleId && this.config.roleId !== 'your_role_id_here') {
                status += `✅ **Role ID Configured:** ${this.config.roleId}\n`;
                status += `📢 Role will be pinged when banners are sent\n\n`;
            } else {
                status += `❌ **Role ID Not Configured**\n`;
                status += `📝 Set ROLE_ID in your .env file or config\n\n`;
            }
            
            // Check text file
            const messagePath = './banner-message.txt';
            if (fs.existsSync(messagePath)) {
                const fileContent = fs.readFileSync(messagePath, 'utf8').trim();
                status += `✅ **Text File Found:** banner-message.txt\n`;
                status += `📄 **Current Message:** "${fileContent}"\n\n`;
            } else {
                status += `❌ **Text File Missing:** banner-message.txt\n`;
                status += `📝 Create this file to customize banner messages\n\n`;
            }
            
            // Show example of what the message will look like
            const customMessage = this.readBannerMessage();
            const rolePing = this.config.roleId && this.config.roleId !== 'your_role_id_here' 
                ? `<@&${this.config.roleId}>` 
                : '';
            
            status += `📤 **Example Message Format:**\n`;
            status += `\`\`\`\n${rolePing} ${customMessage}\n🎯 X Banner captured!\n}\n\`\`\``;
            
            await message.reply(status);
        } catch (error) {
            console.error('Error checking banner config:', error);
            await message.reply('❌ Error checking banner configuration: ' + error.message);
        }
    }

    async cleanupOldScreenshots() {
        try {
            console.log('🧹 Cleaning up old screenshots...');

            const fs = await import('fs');
            const path = await import('path');

            const screenshotDir = './';
            const files = fs.readdirSync(screenshotDir);
            const now = Date.now();
            const oneDayAgo = now - (6 * 60 * 60 * 1000); // 6 hours ago

            let deletedCount = 0;

            for (const file of files) {
                if (file.endsWith('.png') && (file.includes('banner') || file.includes('screenshot') || file.includes('test') || file.includes('countdown'))) {
                    const filePath = path.join(screenshotDir, file);
                    const stats = fs.statSync(filePath);

                    if (stats.mtime.getTime() < oneDayAgo) {
                        fs.unlinkSync(filePath);
                        console.log(`🗑️ Deleted old screenshot: ${file}`);
                        deletedCount++;
                    }
                }
            }

            console.log(`✅ Cleanup complete. Deleted ${deletedCount} old screenshots.`);

        } catch (error) {
            console.error('❌ Error during screenshot cleanup:', error);
        }
    }





    async start() {
        try {
            await this.client.login(this.config.discordToken);
        } catch (error) {
            console.error('Failed to login to Discord:', error);
            throw error;
        }
    }

    async stop() {
        console.log('🛑 Stopping bot...');
        this.isRunning = false;

        try {
            // if (this.tesseractWorker) { // Removed as per edit hint
            //     await this.tesseractWorker.terminate(); // Removed as per edit hint
            //     this.tesseractWorker = null; // Removed as per edit hint
            //     console.log('✅ Tesseract worker terminated'); // Removed as per edit hint
            // } // Removed as per edit hint

            if (this.browser) {
                await this.browser.close();
                this.browser = null;
            }

            if (this.client) {
                await this.client.destroy();
            }

            console.log('✅ Bot stopped successfully');
        } catch (error) {
            console.error('Error stopping bot:', error);
        }
    }
}

// Start the bot
const bot = new ASTDXBannerBot(config);

// Handle graceful shutdown
process.on('SIGINT', async () => {
    console.log('🛑 Shutting down bot...');
    await bot.stop();
    process.exit(0);
});

process.on('SIGTERM', async () => {
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