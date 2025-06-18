// commands/setup.js

const {
    SlashCommandBuilder,
    EmbedBuilder,
    ButtonBuilder,
    ButtonStyle,
    ActionRowBuilder,
    MessageFlags
} = require('discord.js');
const setupManager = require('../utils/setupManager');
const xpDb = require('../xpManager');
const noblox = require('noblox.js');

const PENDING_CHANNEL_ID = '1382426084028584047';

module.exports = {
    data: new SlashCommandBuilder()
        .setName('setup')
        .setDescription('Create a pending setup request for your Roblox group')
        .addStringOption(opt =>
            opt
                .setName('groupid')
                .setDescription('Your Roblox Group ID (you must be the group owner)')
                .setRequired(true)
        )
        .addStringOption(opt =>
            opt
                .setName('premiumkey')
                .setDescription('(Optional) Premium serial key')
                .setRequired(false)
        ),

    async execute(interaction) {
        // 1) Defer the reply (ephemeral)
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const guildId = interaction.guild.id;
        const invokingUserId = interaction.user.id;
        const channelId = interaction.channel.id;
        const groupId = interaction.options.getString('groupid');
        const premiumKey = interaction.options.getString('premiumkey') || null;

        // 2) Check if group already configured elsewhere
        const otherGuild = await setupManager.findGuildByGroupId(groupId);
        if (otherGuild && otherGuild !== guildId) {
            await interaction.editReply({
                embeds: [
                    new EmbedBuilder()
                        .setTitle('🚫 Group Already Configured')
                        .setDescription('This Roblox group is already configured on another Discord server.')
                        .setColor(0xED4245)
                        .setTimestamp()
                ],
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        // 3) Check if pending setup exists elsewhere
        const pendingGuild = await setupManager.findPendingGuildByGroupId(groupId);
        if (pendingGuild && pendingGuild !== guildId) {
            await interaction.editReply({
                embeds: [
                    new EmbedBuilder()
                        .setTitle('🚫 Group Pending Setup Elsewhere')
                        .setDescription('A setup request for this Roblox group is already pending in another server.')
                        .setColor(0xED4245)
                        .setTimestamp()
                ],
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        // 4) Check existing final config in this guild
        const currentCfg = await setupManager.getConfig(guildId);
        if (currentCfg?.groupId) {
            if (currentCfg.groupId === groupId) {
                await interaction.editReply({
                    embeds: [
                        new EmbedBuilder()
                            .setTitle('🚫 Already Configured')
                            .setDescription('This server is already configured with that same group.')
                            .setColor(0xED4245)
                            .setTimestamp()
                    ],
                    flags: MessageFlags.Ephemeral
                });
                return;
            }
            await interaction.editReply({
                content:
                    '❌ You already have a group configured. To switch to another group, please use `/transfer-group` instead.',
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        // 5) Check pending in this guild
        const existingPending = await setupManager.getPendingSetup(guildId);
        if (existingPending) {
            if (existingPending.groupId === groupId) {
                await interaction.editReply({
                    embeds: [
                        new EmbedBuilder()
                            .setTitle('🚫 Pending Setup Exists')
                            .setDescription('A setup request for that exact Group ID is already pending.')
                            .setColor(0xED4245)
                            .setTimestamp()
                    ],
                    flags: MessageFlags.Ephemeral
                });
                return;
            }
            await interaction.editReply({
                content:
                    '❌ You already have a pending setup request. To configure a different group, please wait or use `/transfer-group`.',
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        // 6) Fetch group info from Roblox
        let groupInfo;
        try {
            groupInfo = await noblox.getGroup(parseInt(groupId, 10));
        } catch {
            await interaction.editReply({
                content: '❌ Failed to fetch group info. Make sure the Group ID is correct.',
                flags: MessageFlags.Ephemeral
            });
            return;
        }
        const groupOwnerId = groupInfo.owner?.userId;
        if (!groupOwnerId) {
            await interaction.editReply({
                content: '❌ Cannot determine the owner of that group.',
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        // 7) Ensure user has linked Roblox account
        const linkedRobloxName = await xpDb.getRobloxId(invokingUserId);
        if (!linkedRobloxName) {
            await interaction.editReply({
                content: '❌ You must link your Roblox account first using `/verify`.',
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        // 8) Convert linked username to ID and verify ownership
        let linkedRobloxId;
        try {
            linkedRobloxId = await noblox.getIdFromUsername(linkedRobloxName);
        } catch {
            await interaction.editReply({
                content:
                    '❌ Could not verify your Roblox username. Please unlink and re-link with `/unlink` then `/link`.',
                flags: MessageFlags.Ephemeral
            });
            return;
        }
        if (linkedRobloxId !== groupOwnerId) {
            await interaction.editReply({
                content: '❌ You are not the owner of this Roblox group.',
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        // 9) Save pending setup
        await setupManager.setPendingSetup(guildId, {
            groupId,
            premiumKey,
            ownerDiscordId: invokingUserId,
            invokingChannelId: channelId
        });

        // 9.a) ALSO write the final config immediately so /update funzioni subito
        await setupManager.setConfig(guildId, {
            groupId,
            roleBindings: [],         // imposta binding di default o personalizzati
            verificationRoleId: null,
            unverifiedRoleId: null,
            bypassRoleId: null
        });

        // 10) Notify the user that setup is pending
        const pendingEmbedUser = new EmbedBuilder()
            .setTitle('⚙️ Setup Pending')
            .setDescription([
                `**Group ID:** ${groupId}`,
                premiumKey ? `**Premium Key:** \`${premiumKey}\`` : '_No premium key provided_',
                '',
                'The request has been queued. Once the bot is added to the group, an admin in the pending channel can confirm it.'
            ].join('\n'))
            .setColor(0xffa500)
            .setTimestamp();

        await interaction.editReply({
            embeds: [pendingEmbedUser],
            flags: MessageFlags.Ephemeral
        });

        // 11) Post a confirmation button in the pending-requests channel
        const confirmButton = new ButtonBuilder()
            .setCustomId(`confirm_join_${guildId}`)
            .setLabel('✅ Confirm Bot is in Group')
            .setStyle(ButtonStyle.Success);

        const actionRow = new ActionRowBuilder().addComponents(confirmButton);

        const pendingEmbedChannel = new EmbedBuilder()
            .setTitle('🚧 Bot Join Request')
            .addFields(
                { name: 'User', value: `<@${invokingUserId}> (${invokingUserId})` },
                {
                    name: 'Requested Group',
                    value: `[${groupId}](https://www.roblox.com/groups/${groupId})`
                },
                {
                    name: '\u200B',
                    value: '⚠️ Please add the bot to the group, then click the button below.',
                    inline: false
                }
            )
            .setColor(0xFFA500)
            .setTimestamp();

        const pendingChannel = await interaction.client.channels.fetch(PENDING_CHANNEL_ID);
        if (pendingChannel?.isTextBased()) {
            await pendingChannel.send({
                embeds: [pendingEmbedChannel],
                components: [actionRow]
            });
        } else {
            console.error(`❌ PENDING_CHANNEL_ID (${PENDING_CHANNEL_ID}) is not a text channel.`);
        }
    }
};
