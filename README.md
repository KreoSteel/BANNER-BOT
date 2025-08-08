# ASTDX Banner Bot - Alternating Capture Strategy

## Problem Solved
The bot was capturing duplicate banners because the livestream rapidly switches between X and Y banners in the same screen area every 15-19 seconds. The previous intelligent capture system was still causing duplicates.

## New Approach: Alternating Capture Strategy
Instead of trying to capture both banners simultaneously, the bot now uses a **time-based alternating strategy**:

### How It Works
1. **X Banner**: Captured at minute 31 of every hour
2. **Y Banner**: Captured at minute 1 of every hour
3. **Simple Deduplication**: Uses MD5 hashing to avoid sending identical images
4. **Time Protection**: Minimum 30 seconds between any captures

### Key Features
- **One Banner at a Time**: Only captures one banner per scheduled time
- **Hash-Based Deduplication**: Keeps track of recent image hashes to avoid duplicates
- **Page Refresh**: Always refreshes the page before capture to ensure latest content
- **Time-Based Scheduling**: Predictable capture times that work with the livestream's switching pattern

### Configuration
```javascript
captureStrategy: {
    xBannerMinute: 31, // Capture X banner at minute 31
    yBannerMinute: 1,  // Capture Y banner at minute 1
    minTimeBetweenCaptures: 30000, // Minimum 30 seconds between captures
    hashCacheSize: 5 // Keep last 5 hashes to avoid duplicates
}
```

### Discord Commands
- `!test-alternating-capture` - Test both X and Y banner capture
- `!test-single-capture` - Test single banner capture
- `!banner-status` - Show current banner capture status
- `!test-x` - Manual X banner capture
- `!test-y` - Manual Y banner capture
- `!extension-status` - Check uBlock Origin extension status
- `!banner-config` - Check role pinging and text file configuration

### Why This Approach Works
1. **Predictable Timing**: The livestream switches every 15-19 seconds, so capturing at specific minutes (31 and 1) ensures we get different banners
2. **No Complex Detection**: Removes the unreliable change detection system
3. **Simple Deduplication**: Basic hash checking prevents sending identical images
4. **Time Protection**: Prevents rapid successive captures

### Monitoring Schedule
- **Every hour at minute 31**: Capture X Banner
- **Every hour at minute 1**: Capture Y Banner
- **Continuous monitoring**: Bot checks every minute for capture times

### Installation & Usage
1. Set up environment variables in `.env`
2. Run `npm install`
3. Start with `node bot.js`
4. Bot will automatically capture banners at scheduled times

### Role Pinging & Custom Messages
The bot can ping a specific Discord role and include custom text when banners are sent:

#### Role Pinging Setup
1. **Get your role ID**: Right-click the role in Discord and copy the ID
2. **Add to environment**: Add `ROLE_ID=your_role_id_here` to your `.env` file
3. **Verify**: Use `!banner-config` command to check role configuration

#### Custom Message Setup
1. **Edit text file**: Modify `banner-message.txt` to customize the message
2. **Format**: The text will be included with every banner post
3. **Check status**: Use `!banner-config` to see current message and example format

#### Example Message Format
```
@RoleName 🎯 New banner detected! Check it out!
🎯 X Banner captured!
⏰ 12/25/2023, 2:31:45 PM
```

### Ad Blocker Extension Setup
The bot uses uBlock Origin Lite to block ads. If you see "Failed to load extension" errors:

1. **Check extension status**: Use `!extension-status` command
2. **Manual setup**: Run `npm run setup-adblocker` for instructions
3. **Download extension**: Get uBlock Origin Lite from https://github.com/uBlockOrigin/uBlock-Origin/releases
4. **Extract to**: `./extensions/ublock-origin-lite/`
5. **Verify**: Make sure `manifest.json` is in the extension root directory

**Note**: The bot will work without the ad blocker, but you may see ads during banner captures.

### Troubleshooting
- If duplicates still occur, increase `minTimeBetweenCaptures`
- If missing banners, check the livestream URL and browser status
- Use `!banner-status` to check current bot status
- Use `!extension-status` to check ad blocker extension status

This approach is much simpler and more reliable than the previous complex change detection system.