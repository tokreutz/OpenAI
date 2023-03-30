'use strict';

const { Driver, Device } = require('homey');
const { OpenAIApi } = require('openai');
const { v4: uuidv4 } = require('uuid');

/**
 * This is the driver for chat bot devices that communicate with
 * OpenAI APIs to add LLM driven conversation logic for Homey.
 */
class ChatBotDriver extends Driver {
  /**
   * onInit is called when the driver is initialized.
   */
  async onInit() {
    this.homey.flow.getActionCard('send_question')
      .registerRunListener(async (args, state) => {
        const { question, device } = args;
        return this.queueQuestion(device, question);
      });

    this.homey.flow.getActionCard('clear_history')
      .registerRunListener(async (args, state) => {
        const { device } = args;
        return this.queueClearChatHistory(device);
      });

    this.log('ChatBotDriver has been initialized');
  }

  /**
   * Generates a unique ID for each chatbot device.
   */
  _generateUniqueId() {
    return uuidv4();
  }

  /**
   * onPairListDevices is called when a user is adding a device
   * and the 'list_devices' view is called.
   * This should return list containing a chatbot device ready for pairing.
   * There can be any number of chatbot devices added to Homey.
   * Each device will have an id based on the conversation id for the chat.
   */
  async onPairListDevices() {
    return [
      {
        name: 'ChatBot',
        data: {
          id: this._generateUniqueId(),
        },
      },
    ];
  }

 /**
   * Enqueue a Query OpenAI APIs for the answer to the question.
   * Queries are run in a queue to prevent concurrency issues that might
   * affect chat history.
   * @param {Device} chatbot 
   * @param {string} question 
   * @returns {{ completion: string }} The answer to the question in a completion token.
   */
  async queueQuestion(chatbot, question) {
    let settings = chatbot.getSettings();

    // handle timeout according to settings
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Request timed out')), settings.timeout)
    );

    let x =  await Promise.race([
      this.queue(chatbot, async () => this.sendQuestion(chatbot, question, settings)),
      timeoutPromise
    ]);

    return x;
  }

  /**
   * Query OpenAI APIs for the answer to the question.
   * @param {Device} chatbot 
   * @param {string} question 
   * @param {*} settings 
   * @returns {{ completion: string }} The answer to the question in a completion token.
   */
  async sendQuestion(chatbot, question, settings) {
    let chat = this.getChatHistory(chatbot);

    chat.push({ role:'user', content: question });
    
    let response = await this.sendChatRequest(chat, settings);

    if (response) {
      chat.push(response);
    }

    await this.setChatHistory(chatbot, chat);

    return { message: response.content };
  }

  /**
   * Send completion request to OpenAI APIs for the given chat.
   * @param {Array<{ role:string, content:string}>} chat 
   * @param {*} settings 
   * @returns {Promise<{ completion: string }>} The answer to the question in a completion token.
   */
  async sendChatRequest(chat, settings) {
    let response = await this.getOpenAI().createChatCompletion({
      model: settings.model,
      messages: chat,
      temperature: +settings.temperature,
      max_tokens: +settings.max_tokens,
    });
    
    let finish_reason = response.data.choices[0].finish_reason;
    if (finish_reason === 'stop') {
      let message = response.data.choices[0].message;
      return message;
    }
    else if (finish_reason === 'length') {
      throw new Error('OpenAI API returned incomplete model output due to max_tokens parameter or token limit');
    }
    else if (finish_reason === 'content_filter') {
      throw new Error('OpenAI API returned incomplete model output due to a flag from content filters');
    }
    else {
      // Note: finish_reason === null is a valid case when doing streaming.
      throw new Error('OpenAI API returned incomplete model output due to unknown reason');
    }
  }

  /**
   * Gets the chat history for the chatbot device.
   * @returns {Array<{role: string, content: string}>} The chat history for the chatbot device.
   */
  getChatHistory(chatbot) {
    return chatbot.getStoreValue('history');
  }

  /**
   * Updates the chat history for the chatbot device.
   * @param {Device} chatbot
   * @param {Array<{role: string, content: string}>} history 
   */
  async setChatHistory(chatbot, history) {
    await chatbot.setStoreValue('history', history);
  }

  /**
   * Enqueues a clear of the chat history for the chatbot device.
   * Queueing to not interfere with ongoing chat requests that might
   * alter the chat history.
   * @param {Device} chatbot
   */
  async queueClearChatHistory(chatbot) {
    return await this.queue(chatbot, async () => this.clearChatHistory(chatbot));
  }

  /**
   * Clears the chat history for the chatbot device.
   * @param {Device} chatbot
   */
  async clearChatHistory(chatbot) {
    let settings = chatbot.getSettings();
    let systemMessage = { role:'system', content: settings.system_message };
    let newHistory = [systemMessage];
    await chatbot.setStoreValue('history', newHistory);
  }

  /**
   * Reset the chatbot device state.
   * @param {Device} chatbot
   */
  resetChatbot(chatbot) {
    this.clearChatHistory(chatbot);
  }

  /**
   * @returns {OpenAIApi} The OpenAI API instance.
   */
  getOpenAI() {
    return this.homey.app.openai;
  }

  /**
   * Enqueues a task to run on the chat bot device.
   * @param {Device} chatbot The chatbot device.
   * @param {*} task A promise to queue after the current task on the chatbot device.
   * @returns 
   */
  async queue(chatbot, task) {
    if (!chatbot.mutex) {
      // Note: This part is not thread safe, but it's not a big deal.
      //       The chance of concurrency is low anyway.
      chatbot.mutex = new Mutex();
    }

    let mutex = chatbot.mutex;
    return await mutex.runExclusive(async () => task());
  }
}

class Mutex {
  constructor() {
    this.queue = Promise.resolve();
  }

  async lock() {
    let unlock;
    const newLock = new Promise((resolve) => {
      unlock = resolve;
    });

    const previousLock = this.queue;
    this.queue = this.queue.then(() => newLock);
    await previousLock;
    return unlock;
  }

  async runExclusive(task) {
    const unlock = await this.lock();
    try {
      return await task();
    }
    finally {
      unlock();
    }
  }
}

module.exports = ChatBotDriver;
