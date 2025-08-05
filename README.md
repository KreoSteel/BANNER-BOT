# Banner Bot

A Discord bot that monitors ASTDX livestream banners using Puppeteer and Discord.js.

## Prerequisites

- **Node.js** (version 18 or higher)
- **npm** (comes with Node.js)
- **Discord Bot Token** (create a bot at https://discord.com/developers/applications)
- **Channel ID** (the Discord channel where the bot will operate)
- **Livestream URL** (the YouTube livestream to monitor)

## Setup Instructions

1. **Clone or Download the Repository**

   ```sh
   git clone <repository-url>
   cd BANNER BOT
   ```

2. **Install Dependencies**

   ```sh
   npm install
   ```

3. **Configure Environment Variables**

   Create a `.env` file in the root directory with the following content:

   ```env
   DISCORD_TOKEN=your_discord_token_here
   CHANNEL_ID=your_channel_id_here
   LIVESTREAM_URL=https://www.youtube.com/watch?v=your_livestream_id
   ```

   Replace the values with your actual Discord bot token, channel ID, and livestream URL.

4. **(Optional) Setup uBlock Origin Extension**

   If you want to use the adblocker extension, run:

   ```sh
   npm run setup-adblocker
   ```

5. **Start the Bot**

   ```sh
   npm start
   ```

   Or, for development with auto-reload:

   ```sh
   npm run dev
   ```

## Notes

- The bot uses Puppeteer, which will automatically download a compatible version of Chromium.
- If you encounter issues with browser launching, ensure you have sufficient permissions and disk space.
- For advanced configuration, edit the `config` object in `bot.js`.

## Troubleshooting

- **Browser not found error:** Make sure you are not setting a hardcoded `executablePath` for Puppeteer, or set it according to your OS if needed.
- **Missing dependencies:** Run `npm install` to ensure all packages are installed.

## License

MIT