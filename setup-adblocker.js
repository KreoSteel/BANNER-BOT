import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

async function setupAdBlocker() {
    console.log('🛡️ Setting up uBlock Origin Lite extension...');
    
    const extensionDir = './extensions/ublock-origin-lite';
    const manifestPath = path.join(extensionDir, 'manifest.json');
    
    // Check if extension already exists
    if (fs.existsSync(manifestPath)) {
        console.log('✅ uBlock Origin Lite extension already exists');
        
        // Read and display manifest info
        try {
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            console.log(`📦 Extension version: ${manifest.version}`);
            console.log(`📦 Extension name: ${manifest.name}`);
            console.log(`📦 Minimum Chrome version: ${manifest.minimum_chrome_version || 'Not specified'}`);
        } catch (error) {
            console.log('⚠️ Could not read manifest.json:', error.message);
        }
        
        return;
    }
    
    console.log('📥 Extension not found. You need to manually download uBlock Origin Lite.');
    console.log('');
    console.log('📋 Instructions:');
    console.log('1. Go to: https://github.com/uBlockOrigin/uBlock-Origin/releases');
    console.log('2. Download the latest "uBlock0.chromium.zip" file');
    console.log('3. Extract the contents to: ./extensions/ublock-origin-lite/');
    console.log('4. Make sure the manifest.json file is in the root of the extension directory');
    console.log('');
    console.log('🔧 Alternative: Use a different ad blocker or run without one');
    console.log('The bot will work without an ad blocker, but you may see ads.');
    
    // Create extensions directory if it doesn't exist
    if (!fs.existsSync('./extensions')) {
        fs.mkdirSync('./extensions', { recursive: true });
        console.log('✅ Created extensions directory');
    }
    
    if (!fs.existsSync(extensionDir)) {
        fs.mkdirSync(extensionDir, { recursive: true });
        console.log('✅ Created ublock-origin-lite directory');
    }
}

// Run the setup
setupAdBlocker().catch(console.error);