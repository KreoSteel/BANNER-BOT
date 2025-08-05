import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import os from 'os';

console.log('🛡️ Setting up uBlock Origin Lite for Puppeteer...');

// Create extensions directory
const extensionsDir = './extensions';
const ublockDir = path.join(extensionsDir, 'ublock-origin-lite');

if (!fs.existsSync(extensionsDir)) {
    fs.mkdirSync(extensionsDir, { recursive: true });
}

if (!fs.existsSync(ublockDir)) {
    fs.mkdirSync(ublockDir, { recursive: true });
}

// Download uBlock Origin Lite
console.log('📥 Downloading uBlock Origin Lite...');

try {
    // Get the latest release info from GitHub API
    console.log('🔍 Finding latest uBlock Origin Lite release...');
    const apiUrl = 'https://api.github.com/repos/gorhill/ublock/releases/latest';
    const releaseInfo = execSync(`curl -s "${apiUrl}"`, { encoding: 'utf8' });
    const release = JSON.parse(releaseInfo);
    
    // Find the Chromium zip asset for uBlock Origin Lite
    let chromiumAsset = release.assets.find(asset => 
        asset.name.includes('chromium') && asset.name.includes('lite') && asset.name.endsWith('.zip')
    );
    
    if (!chromiumAsset) {
        // Fallback: try to find any chromium asset if lite version not found
        const fallbackAsset = release.assets.find(asset => 
            asset.name.includes('chromium') && asset.name.endsWith('.zip')
        );
        
        if (!fallbackAsset) {
            throw new Error('Could not find Chromium version in latest release');
        }
        
        console.log(`⚠️ Lite version not found, using: ${fallbackAsset.name}`);
        chromiumAsset = fallbackAsset;
    } else {
        console.log(`📦 Found Lite version: ${chromiumAsset.name}`);
    }
    
    const zipPath = path.join(extensionsDir, 'ublock-lite.zip');
    
    // Download with proper headers and follow redirects
    console.log('⬇️ Downloading...');
    execSync(`curl -L -H "Accept: application/octet-stream" -o "${zipPath}" "${chromiumAsset.browser_download_url}"`);
    
    // Check if file was downloaded properly
    const stats = fs.statSync(zipPath);
    console.log(`📊 Downloaded ${Math.round(stats.size / 1024)}KB`);
    
    if (stats.size < 1000) {
        throw new Error('Download appears incomplete (file too small)');
    }
    
    // Extract the zip file using appropriate method for the OS
    console.log('📦 Extracting uBlock Origin Lite...');
    
    if (os.platform() === 'win32') {
        // Windows: Use PowerShell's Expand-Archive
        const powershellCmd = `powershell -command "Expand-Archive -Path '${zipPath}' -DestinationPath '${ublockDir}' -Force"`;
        execSync(powershellCmd);
    } else {
        // Unix-like systems: Use unzip
        execSync(`unzip -o "${zipPath}" -d "${ublockDir}"`);
    }
    
    // Clean up zip file
    fs.unlinkSync(zipPath);
    
    console.log('✅ uBlock Origin Lite setup complete!');
    console.log('📁 Extension location:', ublockDir);
    
    // Check extraction structure and find manifest.json
    function findManifest(dir) {
        const items = fs.readdirSync(dir);
        
        // Check current directory
        if (items.includes('manifest.json')) {
            return dir;
        }
        
        // Check subdirectories (one level deep)
        for (const item of items) {
            const itemPath = path.join(dir, item);
            if (fs.statSync(itemPath).isDirectory()) {
                const subItems = fs.readdirSync(itemPath);
                if (subItems.includes('manifest.json')) {
                    return itemPath;
                }
            }
        }
        return null;
    }
    
    const manifestDir = findManifest(ublockDir);
    if (manifestDir) {
        console.log('✅ Manifest file found - extension ready to use!');
        if (manifestDir !== ublockDir) {
            console.log(`📂 Extension files located in: ${manifestDir}`);
            console.log('💡 You may need to use this subdirectory path in your Puppeteer config');
        }
    } else {
        console.log('⚠️ Manifest file not found. Contents of extraction:');
        try {
            const contents = fs.readdirSync(ublockDir);
            contents.forEach(item => {
                const itemPath = path.join(ublockDir, item);
                const isDir = fs.statSync(itemPath).isDirectory();
                console.log(`  ${isDir ? '📁' : '📄'} ${item}`);
            });
        } catch (e) {
            console.log('  Error reading directory contents');
        }
    }
    
} catch (error) {
    console.error('❌ Failed to download uBlock Origin Lite:', error.message);
    console.log('💡 Manual setup required:');
    console.log('1. Download uBlock Origin Lite from: https://github.com/gorhill/ublock/releases');
    console.log('2. Extract to: ./extensions/ublock-origin-lite/');
    console.log('3. Make sure the manifest.json file is in the ublock-origin-lite folder');
    console.log('💡 Or install 7-Zip and add it to PATH for automatic extraction');
}