const { parseBidMessage } = require('../transactions/bids');
const { markBidEdited } = require('../transactions/auctions');

module.exports = {
  name: 'messageUpdate',
  async execute(oldMessage, newMessage) {
    const message = newMessage.partial ? await newMessage.fetch().catch(() => null) : newMessage;
    if (!message?.guild || message.author?.bot) return;
    if (String(oldMessage.content || '') === String(message.content || '')) return;
    if (!parseBidMessage(oldMessage.content) && !parseBidMessage(message.content)) return;
    await markBidEdited(message.channel.id, message.author.id);
  },
};
