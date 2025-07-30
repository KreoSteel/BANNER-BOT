import { Client, GatewayIntentBits, AttachmentBuilder, Events } from 'discord.js';
import puppeteer from 'puppeteer';
import fs from 'fs';

// Load environment variables
const dotenv = await import('dotenv');
dotenv.config();

const config = {
    discordToken: process.env.DISCORD_TOKEN || 'your_discord_token_here',
    channelId: process.env.CHANNEL_ID || 'your_channel_id_here',
    livestreamUrl: process.env.LIVESTREAM_URL || 'https://www.youtube.com/watch?v=your_livestream_id',
    xBannerArea: {
        x: 50,     // X coordinate of X banner
        y: 50,     // Y coordinate of X banner
        width: 1200, // Width of X banner area
        height: 900 // Height of X banner area
    },
    yBannerArea: {
        x: 50,     // X coordinate of Y banner (same as X banner)
        y: 50,     // Y coordinate of Y banner (same as X banner)
        width: 1200, // Width of Y banner area (same as X banner)
        height: 900 // Height of Y banner area (same as X banner)
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
        
        this.setupDiscordClient();
    }

    async setupDiscordClient() {
        this.client.on(Events.ClientReady, () => {
            console.log(`✅ Bot logged in as ${this.client.user.tag}`);
            this.startMonitoring();
        });

        this.client.on(Events.MessageCreate, async (message) => {
            if (message.author.bot) return;
            
            // Manual commands for testing
            if (message.content === '!test-x') {
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
            }
        });
    }

    async startMonitoring() {
        try {
            console.log('🚀 Starting browser...');
            
            // Set up browser with extensions
            const userDataDir = './browser-data';
            
            this.browser = await puppeteer.launch({
                headless: 'new',
                userDataDir: userDataDir,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--no-first-run',
                    '--no-zygote',
                    '--disable-gpu',
                    '--disable-web-security',
                    '--disable-features=VizDisplayCompositor',
                    '--disable-extensions-except=./extensions/ublock-origin',
                    '--load-extension=./extensions/ublock-origin',
                    '--disable-background-timer-throttling',
                    '--disable-backgrounding-occluded-windows',
                    '--disable-renderer-backgrounding',
                    '--memory-pressure-off',
                    '--max_old_space_size=512'
                ]
            });

            this.page = await this.browser.newPage();
            
            // Set viewport size
            await this.page.setViewport({ width: 1920, height: 1080 });
            
            // Enable uBlock Origin
            await this.enableAdBlocker();
            
            // Initialize Tesseract OCR
            // await this.initializeTesseract(); // Removed as per edit hint
            
            console.log('📺 Loading livestream...');
            await this.page.goto(this.config.livestreamUrl, { 
                waitUntil: 'networkidle2',
                timeout: 30000 
            });

            // Check if on the correct page
            const currentUrl = this.page.url();
            console.log('📍 Current URL:', currentUrl);
            console.log('🎯 Target URL:', this.config.livestreamUrl);
            
            if (!currentUrl.includes(this.config.livestreamUrl.split('?')[0])) {
                console.error('❌ Not on the correct livestream page! Current URL:', currentUrl);
                await this.sendErrorToDiscord('Not on the correct livestream page! Please check the livestream URL in the config.');
                return;
            } else {
                console.log('✅ On the correct livestream page.');
            }

            // Check if we're on a YouTube page
            if (!currentUrl.includes('youtube.com') && !currentUrl.includes('youtu.be')) {
                console.error('❌ Not on a YouTube page! Current URL:', currentUrl);
                await this.sendErrorToDiscord('Not on a YouTube page! Please check the livestream URL.');
                return;
            }

            // Handle YouTube consent popup and other overlays
            await this.handleYouTubeOverlays();

            // Start the video
            await this.startVideo();

            // Wait for video to load
            await new Promise(resolve => setTimeout(resolve, 5000));
            
            this.isRunning = true;
            console.log('✅ Monitoring started');
            
            // Start the monitoring loop
            this.monitorLoop();
            
        } catch (error) {
            console.error('❌ Failed to start monitoring:', error);
            await this.sendErrorToDiscord('Failed to start monitoring: ' + error.message);
        }
    }

    async enableAdBlocker() {
        try {
            console.log('🛡️ Setting up ad blocker (uBlock Origin only)...');
            // No manual request interception; rely on uBlock Origin extension
            console.log('✅ Ad blocker (uBlock Origin) enabled');
        } catch (error) {
            console.error('❌ Failed to enable ad blocker:', error);
        }
    }

    async skipYouTubeAds() {
        try {
            // Try to click the "Skip Ad" button if it appears
            const skipBtn = await this.page.$('.ytp-ad-skip-button, .ytp-ad-skip-button-modern');
            if (skipBtn) {
                await skipBtn.click();
                console.log('⏩ Skipped ad!');
                // Wait a moment for ad to disappear
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        } catch (e) {
            // No skip button found, do nothing
        }
    }

    async handleYouTubeOverlays() {
        try {
            console.log('🔧 Handling YouTube overlays...');
            
            // Wait for overlays to load
            await new Promise(resolve => setTimeout(resolve, 2000));
            
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
            console.error('❌ Error handling YouTube overlays:', error);
        }
    }

    async startVideo() {
        try {
            console.log('▶️ Attempting to start video...');

            // First, try to find video element with a longer timeout and more flexible approach
            let videoElement = null;
            let attempts = 0;
            const maxAttempts = 10;

            while (!videoElement && attempts < maxAttempts) {
                try {
                    // Try to wait for video element with shorter timeout
                    await this.page.waitForSelector('video', { timeout: 2000 });
                    videoElement = await this.page.$('video');
                    if (videoElement) {
                        console.log('✅ Video element found');
                        break;
                    }
                } catch (e) {
                    console.log(`⏳ Video element not found yet, attempt ${attempts + 1}/${maxAttempts}`);
                    attempts++;
                    
                    // Wait a bit before trying again
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    
                    // Try to refresh the page if we've tried too many times
                    if (attempts === 5) {
                        console.log('🔄 Refreshing page to try again...');
                        await this.page.reload({ waitUntil: 'networkidle2' });
                        await this.handleYouTubeOverlays();
                    }
                }
            }

            if (!videoElement) {
                console.log('⚠️ Video element not found after multiple attempts, trying alternative approach...');
                
                // Try to find any video-related elements
                const videoSelectors = [
                    'video',
                    '[data-video-id]',
                    '.html5-video-player',
                    '.ytp-video-container'
                ];
                
                for (const selector of videoSelectors) {
                    const element = await this.page.$(selector);
                    if (element) {
                        console.log(`✅ Found video-related element: ${selector}`);
                        break;
                    }
                }
                
                // Wait a bit more and try one more time
                await new Promise(resolve => setTimeout(resolve, 3000));
                videoElement = await this.page.$('video');
            }

            if (videoElement) {
                await new Promise(resolve => setTimeout(resolve, 500)); // Let the video load

                // Try to play the video using the video element's play() method
                const played = await this.page.evaluate(async () => {
                    const video = document.querySelector('video');
                    if (video) {
                        try {
                            await video.play();
                            return !video.paused;
                        } catch (e) {
                            console.log('Video play() failed:', e.message);
                            return false;
                        }
                    }
                    return false;
                });

                if (played) {
                    console.log('✅ Video started via video.play()');
                    return;
                }
            }

            // If not playing, try clicking the overlay play button
            const playButtonSelectors = [
                '.ytp-large-play-button', // YouTube's big play button
                '.ytp-play-button',
                'button[aria-label*="Play"]',
                'button[aria-label*="play"]',
                '[aria-label*="Play video"]',
                '[aria-label*="play video"]'
            ];
            let clicked = false;
            for (const selector of playButtonSelectors) {
                const button = await this.page.$(selector);
                if (button) {
                    await button.click();
                    clicked = true;
                    console.log(`🖱️ Clicked play button: ${selector}`);
                    await new Promise(resolve => setTimeout(resolve, 500));
                    break;
                }
            }

            // Fallback: click the center of the video area
            if (!clicked && videoElement) {
                try {
                    const box = await videoElement.boundingBox();
                    if (box) {
                        await this.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
                        console.log('🖱️ Clicked center of video area');
                        await new Promise(resolve => setTimeout(resolve, 500));
                    }
                } catch (e) {
                    console.log('Could not click center of video area:', e.message);
                }
            }

            // Final check: is the video playing now?
            const isPlaying = await this.page.evaluate(() => {
                const video = document.querySelector('video');
                return video && !video.paused;
            });

            if (isPlaying) {
                console.log('✅ Video is now playing!');
            } else {
                console.log('⚠️ Video could not be started automatically, but continuing with monitoring...');
            }
        } catch (error) {
            console.error('❌ Error starting video:', error);
            console.log('⚠️ Continuing with monitoring despite video start error...');
        }
    }

    async monitorLoop() {
        console.log('🔄 Starting monitoring loop...');
        let loopCount = 0;
        let lastCleanupTime = 0;
        
        while (this.isRunning) {
            try {
                loopCount++;
                const now = new Date();
                const currentMinute = now.getMinutes();
                const currentHour = now.getHours();
                const currentTime = Date.now();
                
                console.log(`🔍 Monitoring cycle ${loopCount} - Current time: ${currentHour}:${currentMinute.toString().padStart(2, '0')}`);
                
                // Run cleanup once per hour
                if (currentTime - lastCleanupTime > 60 * 60 * 1000) { // 1 hour
                    await this.cleanupOldScreenshots();
                    lastCleanupTime = currentTime;
                }
                
                // Check if it's time for Y Banner (00:31 minutes) - capture both banners
                if (currentMinute === 31) {
                    console.log('⏰ Y Banner time reached (00:31)! Reloading page and capturing both banners...');
                    
                    // Reload page before capturing
                    await this.refreshPage();
                    
                    // Capture Y Banner first
                    await this.captureYBanner();
                    this.lastYBannerTime = Date.now();
                    
                    // Wait 8 seconds between captures
                    console.log('⏳ Waiting 8 seconds between banner captures...');
                    await new Promise(resolve => setTimeout(resolve, 8000));
                    
                    // Capture X Banner
                    await this.captureXBanner();
                    this.lastXBannerTime = Date.now();
                    
                    // Wait 1 minute to avoid capturing multiple times
                    await new Promise(resolve => setTimeout(resolve, 60000));
                }
                
                // Check if it's time for X Banner (01:01 minutes) - capture both banners
                if (currentMinute === 1) {
                    console.log('⏰ X Banner time reached (01:01)! Reloading page and capturing both banners...');
                    
                    // Reload page before capturing
                    await this.refreshPage();
                    
                    // Capture X Banner first
                    await this.captureXBanner();
                    this.lastXBannerTime = Date.now();
                    
                    // Wait 8 seconds between captures
                    console.log('⏳ Waiting 8 seconds between banner captures...');
                    await new Promise(resolve => setTimeout(resolve, 8000));
                    
                    // Capture Y Banner
                    await this.captureYBanner();
                    this.lastYBannerTime = Date.now();
                    
                    // Wait 1 minute to avoid capturing multiple times
                    await new Promise(resolve => setTimeout(resolve, 60000));
                }
                
                // Wait 1 minute before next check
                console.log('⏳ Waiting 1 minute before next check...');
                await new Promise(resolve => setTimeout(resolve, 60000));
                
            } catch (error) {
                console.error('❌ Error in monitoring loop:', error);
                await new Promise(resolve => setTimeout(resolve, 5000)); // Wait before retrying
            }
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
            console.error('❌ Failed to refresh page:', error);
            await this.sendErrorToDiscord('Failed to refresh page: ' + error.message);
        }
    }

    async clearOverlaysBeforeCapture() {
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
            console.log('Could not clear overlays:', error.message);
        }
    }

    async captureXBanner() {
        try {
            console.log('📸 Capturing X Banner...');
            console.log(`📍 X Banner area: x=${this.config.xBannerArea.x}, y=${this.config.xBannerArea.y}, w=${this.config.xBannerArea.width}, h=${this.config.xBannerArea.height}`);
            
            // Clear any overlays before capturing
            await this.clearOverlaysBeforeCapture();
            // Try to skip ads
            await this.skipYouTubeAds();
            
            // Check if the area is visible
            const isVisible = await this.page.evaluate((area) => {
                const element = document.elementFromPoint(area.x + area.width/2, area.y + area.height/2);
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

            await this.sendToDiscord(screenshot, 'X Banner Update', '🎯 X Banner captured!');
            
        } catch (error) {
            console.error('❌ Failed to capture X banner:', error);
            await this.sendErrorToDiscord('Failed to capture X banner: ' + error.message);
        }
    }

    async captureYBanner() {
        try {
            console.log('📸 Capturing Y Banner...');
            console.log(`📍 Y Banner area: x=${this.config.yBannerArea.x}, y=${this.config.yBannerArea.y}, w=${this.config.yBannerArea.width}, h=${this.config.yBannerArea.height}`);
            
            // Clear any overlays before capturing
            await this.clearOverlaysBeforeCapture();
            // Try to skip ads
            await this.skipYouTubeAds();
            
            // Check if the area is visible
            const isVisible = await this.page.evaluate((area) => {
                const element = document.elementFromPoint(area.x + area.width/2, area.y + area.height/2);
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

            await this.sendToDiscord(screenshot, 'Y Banner Update', '🎯 Y Banner captured!');
            
        } catch (error) {
            console.error('❌ Failed to capture Y banner:', error);
            await this.sendErrorToDiscord('Failed to capture Y banner: ' + error.message);
        }
    }

    async sendToDiscord(screenshotBuffer, filename, message) {
        try {
            const channel = await this.client.channels.fetch(this.config.channelId);
            if (!channel) {
                throw new Error('Channel not found');
            }
            
            const attachment = new AttachmentBuilder(screenshotBuffer, { 
                name: `${filename}_${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.png` 
            });
            
            await channel.send({ 
                content: `${message}\n⏰ ${new Date().toLocaleString()}`, 
                files: [attachment] 
            });
            
            console.log(`✅ Sent ${filename} to Discord`);
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
            
            await channel.send(`❌ **Error:** ${errorMessage}\n⏰ ${new Date().toLocaleString()}`);
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
                const element = document.elementFromPoint(area.x + area.width/2, area.y + area.height/2);
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
            
            console.log('⏳ Waiting 8 seconds before capturing Y Banner...');
            await new Promise(resolve => setTimeout(resolve, 8000));
            
            // Check if Y Banner area is visible (like main functions)
            const yBannerVisible = await this.page.evaluate((area) => {
                const element = document.elementFromPoint(area.x + area.width/2, area.y + area.height/2);
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
            
            // Send Y Banner screenshot to Discord
            await this.sendToDiscord(yBannerScreenshot, 'Test Y Banner', `🧪 Test capture - Y Banner area (${yBannerVisible ? 'Visible' : 'Not visible'})`);
            
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