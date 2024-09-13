const TelegramBot = require('node-telegram-bot-api');
const { TELEGRAM_BOT_TOKEN, WHITELISTED_USERS, OPENAI_MODELS, DEFAULT_MODEL } = require('./config');
const { generateResponse } = require('./api');
const { getConversationHistory, addToConversationHistory, clearConversationHistory } = require('./redis');
const { generateImage, VALID_SIZES } = require('./generateImage');
const { Redis } = require('@upstash/redis');
const { UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN } = require('./config');

let currentModel = DEFAULT_MODEL;

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, {
  cancellation: true
});

const redis = new Redis({
  url: UPSTASH_REDIS_REST_URL,
  token: UPSTASH_REDIS_REST_TOKEN,
});

async function handleStart(msg) {
  const chatId = msg.chat.id;
  try {
    await bot.sendMessage(chatId, `Welcome! The current model is ${currentModel}. Send me a message and I will generate a response using AI.`, {parse_mode: 'Markdown'});
    console.log('Start message sent successfully');
  } catch (error) {
    console.error('Error sending start message:', error);
  }
}

async function handleNew(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  try {
    await clearConversationHistory(userId);
    await bot.sendMessage(chatId, `New conversation started with model ${currentModel}. Previous context has been cleared.`, {parse_mode: 'Markdown'});
    console.log('New conversation message sent successfully');
  } catch (error) {
    console.error('Error handling new conversation:', error);
  }
}

async function handleHistory(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  try {
    const history = await getConversationHistory(userId);
    const historyText = history.map(m => `${m.role}: ${m.content}`).join('\n\n');
    await bot.sendMessage(chatId, `Your conversation history:\n\n${historyText}`, {parse_mode: 'Markdown'});
  } catch (error) {
    console.error('Error retrieving conversation history:', error);
    await bot.sendMessage(chatId, 'Sorry, there was an error retrieving your conversation history.', {parse_mode: 'Markdown'});
  }
}

async function handleHelp(msg) {
  const chatId = msg.chat.id;
  try {
    await bot.sendMessage(chatId, '等待补充', {parse_mode: 'Markdown'});
  } catch (error) {
    console.error('Error sending help message:', error);
  }
}

async function handleSwitchModel(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const args = msg.text.split(' ');
  
  if (args.length < 2) {
    await bot.sendMessage(chatId, 'Please provide a model name to switch to.', {parse_mode: 'Markdown'});
    return;
  }

  const modelName = args[1].trim();
  
  if (OPENAI_MODELS.includes(modelName)) {
    currentModel = modelName;
    await clearConversationHistory(userId);
    await bot.sendMessage(chatId, `Model switched to: ${modelName}. Previous conversation has been cleared.`, {parse_mode: 'Markdown'});
  } else {
    await bot.sendMessage(chatId, `Invalid model name. Use /help to see available models.`, {parse_mode: 'Markdown'});
  }
}

async function handleImageGeneration(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const args = msg.text.split(' ');
  args.shift(); // 移除 "/img" 命令

  let size = '1024x1024';
  let prompt;

  if (VALID_SIZES.includes(args[args.length - 1])) {
    size = args.pop();
    prompt = args.join(' ');
  } else {
    prompt = args.join(' ');
  }

  try {
    console.log(`开始处理图片生成请求. 聊天ID: ${chatId}, 提示: "${prompt}", 尺寸: ${size}`);
    await bot.sendChatAction(chatId, 'upload_photo');
    
    // 生成唯一的请求ID
    const requestId = `img_req:${userId}:${Date.now()}`;
    
    // 检查是否已经生成过图片
    const existingImageUrl = await redis.get(requestId);
    
    if (existingImageUrl) {
      console.log(`使用已生成的图片 URL: ${existingImageUrl}`);
      await bot.sendPhoto(chatId, existingImageUrl, { caption: prompt });
      return;
    }
    
    console.log(`Generating image with prompt: "${prompt}" and size: ${size}`);
    const imageUrl = await generateImage(prompt, size);
    console.log(`Image URL generated: ${imageUrl}`);
    
    if (imageUrl) {
      // 存储生成的图片URL
      await redis.set(requestId, imageUrl, { ex: 3600 }); // 1小时过期
      
      console.log(`开始发送图片. URL: ${imageUrl}`);
      await bot.sendPhoto(chatId, imageUrl, { caption: prompt });
      console.log('Photo sent successfully');
    } else {
      throw new Error('未能获取图片URL');
    }
  } catch (error) {
    console.error('图片生成或发送错误:', error);
    let errorMessage = '生成或发送图片时出错。';
    if (error.response) {
      console.error('API 错误响应:', error.response.data);
      errorMessage += ` API 错误: ${error.response.data.error.message}`;
    } else if (error.request) {
      console.error('没有收到 API 响应');
      errorMessage += ' 未收到 API 响应。';
    } else {
      errorMessage += ` ${error.message}`;
    }
    await bot.sendMessage(chatId, errorMessage);
  }
}

async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  try {
    if (!WHITELISTED_USERS.includes(userId)) {
      await bot.sendMessage(chatId, 'Sorry, you are not authorized to use this bot.', {parse_mode: 'Markdown'});
      return;
    }

    if (msg.text === '/start') {
      await handleStart(msg);
    } else if (msg.text === '/new') {
      await handleNew(msg);
    } else if (msg.text === '/history') {
      await handleHistory(msg);
    } else if (msg.text === '/help') {
      await handleHelp(msg);
    } else if (msg.text.startsWith('/switchmodel')) {
      await handleSwitchModel(msg);
    } else if (msg.text.startsWith('/img')) {
      await handleImageGeneration(msg);
    } else if (msg.text && !msg.text.startsWith('/')) {
      await bot.sendChatAction(chatId, 'typing');
      const conversationHistory = await getConversationHistory(userId);
      const response = await generateResponse(msg.text, conversationHistory, currentModel);
      await addToConversationHistory(userId, msg.text, response);
      await bot.sendMessage(chatId, response, {parse_mode: 'Markdown'});
    } else {
      console.log('Received non-text or unknown command message');
    }
  } catch (error) {
    console.error('Error in handleMessage:', error);
    await bot.sendMessage(chatId, 'Sorry, there was an error processing your message. Please try again later.', {parse_mode: 'Markdown'});
  }
}

module.exports = { bot, handleMessage, handleStart };
