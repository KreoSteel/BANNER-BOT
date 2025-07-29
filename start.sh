#!/bin/bash

# Banner Bot Production Startup Script
echo "🚀 Starting Banner Bot on EC2..."

# Check if .env file exists
if [ ! -f .env ]; then
    echo "❌ .env file not found! Please create it with your configuration."
    echo "Required variables: DISCORD_TOKEN, CHANNEL_ID, LIVESTREAM_URL"
    exit 1
fi

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
    echo "📦 Installing dependencies..."
    npm install
fi

# Set up uBlock Origin if not exists
if [ ! -d "extensions/ublock-origin" ]; then
    echo "🛡️ Setting up uBlock Origin extension..."
    node setup-adblocker.js
fi

# Start the bot
echo "🤖 Starting bot..."
node bot.js 