// commands/update.js
const { SlashCommandBuilder, EmbedBuilder } = require("discord.js");
const noblox = require("noblox.js");
const setupManager = require("../utils/setupManager");
const xpDb = require("../xpManager");
const fs = require("fs").promises;
const path = require("path");

const premiumUsersFile = path.resolve(process.cwd(), "premiumUsers.json");
const premiumRoleId = process.env.DISCORD_PREMIUM_ROLE_ID;

async function isPremiumUser(discordId) {
    try {
        const data = await fs.readFile(premiumUsersFile, "utf-8");
        const json = JSON.parse(data);
        return (json.premiumUsers || []).includes(discordId);
    } catch {
        return false;
    }
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName("update")
        .setDescription("Sync Discord roles based on Roblox rank & verification role")
        .addStringOption(opt =>
            opt
                .setName("roblox")
                .setDescription("Roblox username to update (default = your linked account)")
                .setRequired(false)
        ),

    async execute(interaction) {
        // 1) Defer immediately
        try {
            await interaction.deferReply({ ephemeral: true });
        } catch (err) {
            console.warn("Failed to deferReply (interaction may be invalid):", err);
            return; // Cannot proceed
        }

        // 1.a) Ensure command is run in a guild
        if (!interaction.guildId) {
            return interaction.editReply({
                content: "❌ The `/update` command can only be used in a server (not in DMs).",
                ephemeral: true
            });
        }

        // From here on, always use editReply or followUp
        try {
            // 2) Load config
            const cfg = await setupManager.getConfig(interaction.guildId);
            if (!cfg || !cfg.groupId) {
                return interaction.editReply("❌ This server is not configured. Run `/setup` first.");
            }
            const {
                groupId,
                roleBindings = [],
                verificationRoleId = null,
                unverifiedRoleId = null,
                bypassRoleId = null
            } = cfg;

            // 3) Determine target user
            let robloxName = interaction.options.getString("roblox");
            let targetId = interaction.user.id;

            if (robloxName) {
                // reverse lookup
                const linkedDiscord = await xpDb.getDiscordUserIdFromRobloxName(robloxName);
                if (linkedDiscord) {
                    targetId = linkedDiscord;
                } else {
                    // fallback scan
                    const allLinked = await xpDb.getAllLinked();
                    const found = allLinked.find(l => l.robloxName.toLowerCase() === robloxName.toLowerCase());
                    if (found) {
                        targetId = found.discordId;
                    } else {
                        return interaction.editReply(
                            `❌ No Discord user is linked to Roblox username \`${robloxName}\`. They must run \`/verify\` first.`
                        );
                    }
                }
            } else {
                robloxName = await xpDb.getLinked(targetId);
                if (!robloxName) {
                    return interaction.editReply("❌ You have not linked your Roblox account. Run `/verify` first.");
                }
            }

            // 4) Fetch Roblox userId & rank
            try {
                await noblox.setCookie(process.env.ROBLOX_COOKIE);
            } catch {
                // ignore failure here
            }
            let robloxUserId;
            try {
                robloxUserId = await noblox.getIdFromUsername(robloxName);
            } catch {
                return interaction.editReply(`❌ Could not find Roblox user \`${robloxName}\`.`);
            }

            let rank;
            try {
                rank = await noblox.getRankInGroup(groupId, robloxUserId);
            } catch (err) {
                return interaction.editReply(`❌ Error fetching Roblox group rank: ${err.message}`);
            }

            // 5) Fetch group roles & match
            let roles;
            try {
                roles = await noblox.getRoles(groupId);
            } catch (err) {
                return interaction.editReply(`❌ Error fetching group roles: ${err.message}`);
            }
            const matched = roles.find(r => r.rank === rank) || null;
            const matchedRoleName = matched?.name ?? "None";

            // 6) Build add/remove sets
            const toAdd = new Set();
            const toRemove = new Set();

            // 6a) Add bound Discord role for this rank
            const binding = roleBindings.find(b => b.groupRoleId === matched?.id);
            if (binding) toAdd.add(binding.discordRoleId);

            // 6b) Add verificationRoleId if user linked
            const linkedCheck = await xpDb.getLinked(targetId);
            if (verificationRoleId && linkedCheck) {
                toAdd.add(verificationRoleId);
            }

            // 6c) Add premium role if premium
            if (premiumRoleId) {
                try {
                    if (await isPremiumUser(targetId)) {
                        toAdd.add(premiumRoleId);
                    }
                } catch (e) {
                    console.warn("isPremiumUser error:", e);
                }
            }

            // 7) Fetch GuildMember
            let member;
            try {
                member = await interaction.guild.members.fetch(targetId);
            } catch {
                return interaction.editReply("❌ Could not fetch that member on this server.");
            }

            // 8) Remove outdated roles
            // 8a) group-binding roles not in toAdd
            for (const { discordRoleId } of roleBindings) {
                if (!toAdd.has(discordRoleId) && member.roles.cache.has(discordRoleId)) {
                    toRemove.add(discordRoleId);
                }
            }
            // 8b) Remove unverifiedRoleId if present
            if (unverifiedRoleId && member.roles.cache.has(unverifiedRoleId)) {
                toRemove.add(unverifiedRoleId);
            }
            // 8c) Optionally remove bypassRoleId if needed (custom logic)

            // 9) Apply changes
            try {
                if (toAdd.size) {
                    await member.roles.add([...toAdd], "Sync rank & verification roles");
                }
                if (toRemove.size) {
                    await member.roles.remove([...toRemove], "Remove outdated roles (group bindings or unverified)");
                }
            } catch (err) {
                return interaction.editReply(`❌ Failed to update roles: ${err.message}`);
            }

            // 10) Sync nickname
            try {
                if (member.nickname !== robloxName) {
                    await member.setNickname(robloxName, "Syncing nickname to Roblox username");
                }
            } catch {
                // ignore
            }

            // 11) Confirmation embed
            const embed = new EmbedBuilder()
                .setTitle("🔄 Update Completed")
                .addFields(
                    { name: "Roblox User", value: `\`${robloxName}\``, inline: false },
                    { name: "Discord Member", value: `<@${targetId}>`, inline: false },
                    { name: "Group Role", value: matchedRoleName, inline: false },
                    {
                        name: "Roles Added",
                        value: toAdd.size ? [...toAdd].map(r => `<@&${r}>`).join("\n") : "None",
                        inline: false
                    },
                    {
                        name: "Roles Removed",
                        value: toRemove.size ? [...toRemove].map(r => `<@&${r}>`).join("\n") : "None",
                        inline: false
                    }
                )
                .setColor(0x5865f2)
                .setTimestamp();

            return interaction.editReply({ embeds: [embed] });
        } catch (err) {
            console.error("Unexpected error in /update:", err);
            // If already deferred, use followUp
            if (interaction.deferred || interaction.replied) {
                await interaction.followUp({ content: "❌ Unexpected error occurred.", ephemeral: true });
            } else {
                await interaction.reply({ content: "❌ Unexpected error occurred.", ephemeral: true });
            }
        }
    },
};
