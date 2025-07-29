import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

console.log('🛡️ Setting up uBlock Origin for Puppeteer...');

// Create extensions directory
const extensionsDir = './extensions';
const ublockDir = path.join(extensionsDir, 'ublock-origin');

if (!fs.existsSync(extensionsDir)) {
    fs.mkdirSync(extensionsDir, { recursive: true });
}

if (!fs.existsSync(ublockDir)) {
    fs.mkdirSync(ublockDir, { recursive: true });
}

// Download uBlock Origin
console.log('📥 Downloading uBlock Origin...');

try {
    // Download the latest uBlock Origin from GitHub releases
    const ublockUrl = 'https://github.com/gorhill/uBlock/releases/download/1.56.0/uBlock0.chromium.zip';
    
    // Use curl to download (works on most systems)
    execSync(`curl -L -o ${path.join(extensionsDir, 'ublock.zip')} "${ublockUrl}"`);
    
    // Extract the zip file
    console.log('📦 Extracting uBlock Origin...');
    execSync(`unzip -o ${path.join(extensionsDir, 'ublock.zip')} -d ${ublockDir}`);
    
    // Clean up zip file
    fs.unlinkSync(path.join(extensionsDir, 'ublock.zip'));
    
    console.log('✅ uBlock Origin setup complete!');
    console.log('📁 Extension location:', ublockDir);
    
} catch (error) {
    console.error('❌ Failed to download uBlock Origin:', error.message);
    console.log('💡 Manual setup required:');
    console.log('1. Download uBlock Origin from: https://github.com/gorhill/uBlock/releases');
    console.log('2. Extract to: ./extensions/ublock-origin/');
    console.log('3. Make sure the manifest.json file is in the ublock-origin folder');
}