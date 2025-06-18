// utils/setupManager.js

const path = require('path');
const { QuickDB } = require('quick.db');

// Usa lo stesso file sqlite che già usi per XP
const DB_FILE = path.join(__dirname, '..', 'data.sqlite');
const db = new QuickDB({ filePath: DB_FILE });

module.exports = {
    // --- Configurazione principale ---
    async getConfig(guildId) {
        return (
            (await db.get(`config_${guildId}`)) || {
                groupId: null,
                premiumKey: null,
                roleBindings: [],
                verificationRoleId: null,
                unverifiedRoleId: null,
                bypassRoleId: null
            }
        );
    },

    async setConfig(guildId, config) {
        // Quando si imposta la config definitiva, rimuovi eventuali pending
        await db.delete(`pendingSetup_${guildId}`);
        await db.delete(`pendingTransfer_${guildId}`);
        return db.set(`config_${guildId}`, {
            groupId: config.groupId ?? null,
            premiumKey: config.premiumKey ?? null,
            roleBindings: config.roleBindings ?? [],
            verificationRoleId: config.verificationRoleId ?? null,
            unverifiedRoleId: config.unverifiedRoleId ?? null,
            bypassRoleId: config.bypassRoleId ?? null
        });
    },

    async updateConfig(guildId, partial) {
        const existing = await this.getConfig(guildId);
        const merged = {
            groupId: partial.groupId ?? existing.groupId,
            premiumKey: partial.premiumKey ?? existing.premiumKey,
            roleBindings: partial.roleBindings ?? existing.roleBindings,
            verificationRoleId: partial.verificationRoleId ?? existing.verificationRoleId,
            unverifiedRoleId: partial.unverifiedRoleId ?? existing.unverifiedRoleId,
            bypassRoleId: partial.bypassRoleId ?? existing.bypassRoleId
        };
        return this.setConfig(guildId, merged);
    },

    // --- Pending setup ---
    async setPendingSetup(guildId, data) {
        return db.set(`pendingSetup_${guildId}`, data);
    },
    async getPendingSetup(guildId) {
        return (await db.get(`pendingSetup_${guildId}`)) || null;
    },
    async clearPendingSetup(guildId) {
        return db.delete(`pendingSetup_${guildId}`);
    },

    // --- Pending transfer ---
    async setPendingTransfer(guildId, data) {
        return db.set(`pendingTransfer_${guildId}`, data);
    },
    async getPendingTransfer(guildId) {
        return (await db.get(`pendingTransfer_${guildId}`)) || null;
    },
    async clearPendingTransfer(guildId) {
        return db.delete(`pendingTransfer_${guildId}`);
    },

    // --- Verifica esistenza gruppo già configurato altrove ---
    async findGuildByGroupId(groupId) {
        const entries = await db.all();
        for (const { id, value } of entries) {
            if (typeof id === 'string' && id.startsWith('config_')) {
                const gid = id.slice('config_'.length);
                if (value && value.groupId === groupId) {
                    return gid;
                }
            }
        }
        return null;
    },

    async findPendingGuildByGroupId(groupId) {
        const entries = await db.all();
        for (const { id, value } of entries) {
            if (typeof id === 'string' && id.startsWith('pendingSetup_')) {
                const gid = id.slice('pendingSetup_'.length);
                if (value && value.groupId === groupId) {
                    return gid;
                }
            }
        }
        return null;
    },

    // --- Metodi di debug / utilità ---
    async loadAllConfigs() {
        const out = [];
        const entries = await db.all();
        for (const { id, value } of entries) {
            if (typeof id === 'string' && id.startsWith('config_')) {
                const guildId = id.slice('config_'.length);
                out.push({ guildId, config: value });
            }
        }
        return out;
    },

    async loadAllPendingSetups() {
        const out = [];
        const entries = await db.all();
        for (const { id, value } of entries) {
            if (typeof id === 'string' && id.startsWith('pendingSetup_')) {
                const guildId = id.slice('pendingSetup_'.length);
                out.push({ guildId, pending: value });
            }
        }
        return out;
    },

    async isGroupConfigured(groupId) {
        const gid = await this.findGuildByGroupId(groupId);
        return gid !== null;
    }
}