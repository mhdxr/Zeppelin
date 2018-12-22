import { decorators as d, waitForReaction, waitForReply } from "knub";
import { Constants as ErisConstants, Guild, Member, Message, TextChannel, User } from "eris";
import humanizeDuration from "humanize-duration";
import { GuildCases } from "../data/GuildCases";
import {
  chunkMessageLines,
  convertDelayStringToMS,
  disableLinkPreviews,
  errorMessage,
  findRelevantAuditLogEntry,
  formatTemplateString,
  stripObjectToScalars,
  successMessage,
  trimLines
} from "../utils";
import { GuildMutes } from "../data/GuildMutes";
import { CaseTypes } from "../data/CaseTypes";
import { GuildLogs } from "../data/GuildLogs";
import { LogType } from "../data/LogType";
import Timer = NodeJS.Timer;
import { ZeppelinPlugin } from "./ZeppelinPlugin";
import { GuildActions } from "../data/GuildActions";
import { Case } from "../data/entities/Case";
import { Mute } from "../data/entities/Mute";

enum IgnoredEventType {
  Ban = 1,
  Unban,
  Kick
}

interface IIgnoredEvent {
  type: IgnoredEventType;
  userId: string;
}

const CASE_LIST_REASON_MAX_LENGTH = 80;

export class ModActionsPlugin extends ZeppelinPlugin {
  protected actions: GuildActions;
  protected mutes: GuildMutes;
  protected cases: GuildCases;
  protected serverLogs: GuildLogs;

  protected ignoredEvents: IIgnoredEvent[];

  async onLoad() {
    this.actions = GuildActions.getInstance(this.guildId);
    this.mutes = GuildMutes.getInstance(this.guildId);
    this.cases = GuildCases.getInstance(this.guildId);
    this.serverLogs = new GuildLogs(this.guildId);

    this.ignoredEvents = [];
  }

  getDefaultOptions() {
    return {
      config: {
        dm_on_warn: true,
        dm_on_mute: false,
        dm_on_kick: false,
        dm_on_ban: false,
        message_on_warn: false,
        message_on_mute: false,
        message_on_kick: false,
        message_on_ban: false,
        message_channel: null,
        warn_message: "You have received a warning on {guildName}: {reason}",
        mute_message: "You have been muted on {guildName}. Reason given: {reason}",
        timed_mute_message: "You have been muted on {guildName} for {time}. Reason given: {reason}",
        kick_message: "You have been kicked from {guildName}. Reason given: {reason}",
        ban_message: "You have been banned from {guildName}. Reason given: {reason}",
        alert_on_rejoin: false,
        alert_channel: null
      },
      permissions: {
        note: false,
        warn: false,
        mute: false,
        kick: false,
        ban: false,
        view: false,
        addcase: false,
        massban: true
      },
      overrides: [
        {
          level: ">=50",
          permissions: {
            note: true,
            warn: true,
            mute: true,
            kick: true,
            ban: true,
            view: true,
            addcase: true
          }
        },
        {
          level: ">=100",
          permissions: {
            massban: true
          }
        }
      ]
    };
  }

  ignoreEvent(type: IgnoredEventType, userId: any, timeout: number = null) {
    this.ignoredEvents.push({ type, userId });

    // Clear after expiry (15sec by default)
    setTimeout(() => {
      this.clearIgnoredEvent(type, userId);
    }, timeout || 1000 * 15);
  }

  isEventIgnored(type: IgnoredEventType, userId: any) {
    return this.ignoredEvents.some(info => type === info.type && userId === info.userId);
  }

  clearIgnoredEvent(type: IgnoredEventType, userId: any) {
    this.ignoredEvents.splice(this.ignoredEvents.findIndex(info => type === info.type && userId === info.userId), 1);
  }

  /**
   * Add a BAN action automatically when a user is banned.
   * Attempts to find the ban's details in the audit log.
   */
  @d.event("guildBanAdd")
  async onGuildBanAdd(guild: Guild, user: User) {
    if (this.isEventIgnored(IgnoredEventType.Ban, user.id)) {
      this.clearIgnoredEvent(IgnoredEventType.Ban, user.id);
      return;
    }

    const relevantAuditLogEntry = await findRelevantAuditLogEntry(
      this.guild,
      ErisConstants.AuditLogActions.MEMBER_BAN_ADD,
      user.id
    );

    if (relevantAuditLogEntry) {
      const modId = relevantAuditLogEntry.user.id;
      const auditLogId = relevantAuditLogEntry.id;

      this.actions.fire("createCase", {
        userId: user.id,
        modId,
        type: CaseTypes.Ban,
        auditLogId,
        reason: relevantAuditLogEntry.reason,
        automatic: true
      });
    } else {
      this.actions.fire("createCase", {
        userId: user.id,
        type: CaseTypes.Ban
      });
    }
  }

  /**
   * Add an UNBAN mod action automatically when a user is unbanned.
   * Attempts to find the unban's details in the audit log.
   */
  @d.event("guildBanRemove")
  async onGuildBanRemove(guild: Guild, user: User) {
    if (this.isEventIgnored(IgnoredEventType.Unban, user.id)) {
      this.clearIgnoredEvent(IgnoredEventType.Unban, user.id);
      return;
    }

    const relevantAuditLogEntry = await findRelevantAuditLogEntry(
      this.guild,
      ErisConstants.AuditLogActions.MEMBER_BAN_REMOVE,
      user.id
    );

    if (relevantAuditLogEntry) {
      const modId = relevantAuditLogEntry.user.id;
      const auditLogId = relevantAuditLogEntry.id;

      this.actions.fire("createCase", {
        userId: user.id,
        modId,
        type: CaseTypes.Unban,
        auditLogId,
        automatic: true
      });
    } else {
      this.actions.fire("createCase", {
        userId: user.id,
        type: CaseTypes.Unban,
        automatic: true
      });
    }
  }

  /**
   * Show an alert if a member with prior notes joins the server
   */
  @d.event("guildMemberAdd")
  async onGuildMemberAdd(_, member: Member) {
    if (!this.configValue("alert_on_rejoin")) return;

    const alertChannelId = this.configValue("alert_channel");
    if (!alertChannelId) return;

    const actions = await this.cases.getByUserId(member.id);

    if (actions.length) {
      const alertChannel: any = this.guild.channels.get(alertChannelId);
      alertChannel.send(
        `<@!${member.id}> (${member.user.username}#${member.user.discriminator} \`${member.id}\`) joined with ${
          actions.length
        } prior record(s)`
      );
    }
  }

  @d.event("guildMemberRemove")
  async onGuildMemberRemove(_, member: Member) {
    if (this.isEventIgnored(IgnoredEventType.Kick, member.id)) {
      this.clearIgnoredEvent(IgnoredEventType.Kick, member.id);
      return;
    }

    const kickAuditLogEntry = await findRelevantAuditLogEntry(
      this.guild,
      ErisConstants.AuditLogActions.MEMBER_KICK,
      member.id
    );

    if (kickAuditLogEntry) {
      this.actions.fire("createCase", {
        userId: member.id,
        modId: kickAuditLogEntry.user.id,
        type: CaseTypes.Kick,
        auditLogId: kickAuditLogEntry.id,
        reason: kickAuditLogEntry.reason,
        automatic: true
      });

      this.serverLogs.log(LogType.MEMBER_KICK, {
        user: stripObjectToScalars(member.user),
        mod: stripObjectToScalars(kickAuditLogEntry.user)
      });
    }
  }

  /**
   * Update the specified case by adding more notes/details to it
   */
  @d.command(/update|updatecase/, "<caseNumber:number> <note:string$>")
  @d.permission("note")
  async updateCmd(msg: Message, args: any) {
    const theCase = await this.cases.findByCaseNumber(args.caseNumber);
    if (!theCase) {
      msg.channel.createMessage(errorMessage("Case not found"));
      return;
    }

    await this.actions.fire("createCaseNote", theCase, {
      modId: msg.author.id,
      note: args.note
    });

    msg.channel.createMessage(successMessage(`Case \`#${theCase.case_number}\` updated`));
  }

  @d.command("note", "<userId:userId> <note:string$>")
  @d.permission("note")
  async noteCmd(msg: Message, args: any) {
    const user = await this.bot.users.get(args.userId);
    const userName = user ? `${user.username}#${user.discriminator}` : "member";

    await this.actions.fire("createCase", {
      userId: args.userId,
      modId: msg.author.id,
      type: CaseTypes.Note,
      reason: args.note
    });

    msg.channel.createMessage(successMessage(`Note added on ${userName}`));
  }

  @d.command("warn", "<member:Member> <reason:string$>")
  @d.permission("warn")
  @d.nonBlocking()
  async warnCmd(msg: Message, args: any) {
    // Make sure we're allowed to warn this member
    if (!this.canActOn(msg.member, args.member)) {
      msg.channel.createMessage(errorMessage("Cannot warn: insufficient permissions"));
      return;
    }

    const warnMessage = this.configValue("warn_message")
      .replace("{guildName}", this.guild.name)
      .replace("{reason}", args.reason);

    const messageSent = await this.tryToMessageUser(
      args.member.user,
      warnMessage,
      this.configValue("dm_on_warn"),
      this.configValue("message_on_warn")
    );

    if (!messageSent) {
      const failedMsg = await msg.channel.createMessage("Failed to message the user. Log the warning anyway?");
      const reply = await waitForReaction(this.bot, failedMsg, ["✅", "❌"], msg.author.id);
      failedMsg.delete();
      if (!reply || reply.name === "❌") {
        return;
      }
    }

    await this.actions.fire("createCase", {
      userId: args.member.id,
      modId: msg.author.id,
      type: CaseTypes.Warn,
      reason: args.reason
    });

    msg.channel.createMessage(
      successMessage(`Warned **${args.member.user.username}#${args.member.user.discriminator}**`)
    );

    this.serverLogs.log(LogType.MEMBER_WARN, {
      mod: stripObjectToScalars(msg.member.user),
      member: stripObjectToScalars(args.member, ["user"])
    });
  }

  @d.command("mute", "<member:Member> [time:string] [reason:string$]")
  @d.permission("mute")
  async muteCmd(msg: Message, args: any) {
    if (!this.configValue("mute_role")) {
      msg.channel.createMessage(errorMessage("Cannot mute: no mute role specified"));
      return;
    }

    // Make sure we're allowed to mute this member
    if (!this.canActOn(msg.member, args.member)) {
      msg.channel.createMessage(errorMessage("Cannot mute: insufficient permissions"));
      return;
    }

    let messageSent = true;

    // Convert mute time from e.g. "2h30m" to milliseconds
    const muteTime = args.time ? convertDelayStringToMS(args.time) : null;
    const timeUntilUnmute = muteTime && humanizeDuration(muteTime);

    if (muteTime == null && args.time) {
      // Invalid muteTime -> assume it's actually part of the reason
      args.reason = `${args.time} ${args.reason ? args.reason : ""}`.trim();
    }

    // Apply "muted" role
    this.serverLogs.ignoreLog(LogType.MEMBER_ROLE_ADD, args.member.id);
    const mute: Mute = await this.actions.fire("mute", {
      member: args.member,
      muteTime
    });

    if (!mute) {
      msg.channel.createMessage(errorMessage("Could not mute the user"));
      return;
    }

    const hasOldCase = mute.case_id != null;

    if (hasOldCase) {
      if (args.reason) {
        // Update old case
        await this.actions.fire("createCaseNote", mute.case_id, {
          modId: msg.author.id,
          note: args.reason
        });
      }
    } else {
      // Create new case
      const theCase: Case = await this.actions.fire("createCase", {
        userId: args.member.id,
        modId: msg.author.id,
        type: CaseTypes.Mute,
        reason: args.reason
      });
      await this.mutes.setCaseId(args.member.id, theCase.id);
    }

    // Message the user informing them of the mute
    // Don't message them if we're updating an old mute
    if (args.reason && !hasOldCase) {
      const template = muteTime ? this.configValue("timed_mute_message") : this.configValue("mute_message");

      const muteMessage = formatTemplateString(template, {
        guildName: this.guild.name,
        reason: args.reason,
        time: timeUntilUnmute
      });

      messageSent = await this.tryToMessageUser(
        args.member.user,
        muteMessage,
        this.configValue("dm_on_mute"),
        this.configValue("message_on_mute")
      );
    }

    // Confirm the action to the moderator
    let response;
    if (muteTime) {
      response = `Muted **${args.member.user.username}#${args.member.user.discriminator}** for ${timeUntilUnmute}`;
    } else {
      response = `Muted **${args.member.user.username}#${args.member.user.discriminator}** indefinitely`;
    }

    if (!messageSent) response += " (failed to message user)";
    msg.channel.createMessage(successMessage(response));

    // Log the action
    this.serverLogs.log(LogType.MEMBER_MUTE, {
      mod: stripObjectToScalars(msg.member.user),
      member: stripObjectToScalars(args.member, ["user"])
    });
  }

  @d.command("unmute", "<member:Member> [time:string] [reason:string$]")
  @d.permission("mute")
  async unmuteCmd(msg: Message, args: any) {
    if (!this.configValue("mute_role")) {
      msg.channel.createMessage(errorMessage("Cannot unmute: no mute role specified"));
      return;
    }

    // Make sure we're allowed to mute this member
    if (!this.canActOn(msg.member, args.member)) {
      msg.channel.createMessage(errorMessage("Cannot unmute: insufficient permissions"));
      return;
    }

    // Check if they're muted in the first place
    const mute = await this.mutes.findExistingMuteForUserId(args.member.id);
    if (!mute) {
      msg.channel.createMessage(errorMessage("Cannot unmute: member is not muted"));
      return;
    }

    // Convert unmute time from e.g. "2h30m" to milliseconds
    const unmuteTime = args.time ? convertDelayStringToMS(args.time) : null;

    if (unmuteTime == null && args.time) {
      // Invalid unmuteTime -> assume it's actually part of the reason
      args.reason = `${args.time} ${args.reason ? args.reason : ""}`.trim();
    }

    if (unmuteTime) {
      // If we have an unmute time, just update the old mute to expire in that time
      const timeUntilUnmute = unmuteTime && humanizeDuration(unmuteTime);
      await this.actions.fire("unmute", { member: args.member, unmuteTime });
      args.reason = args.reason ? `Timed unmute: ${args.reason}` : "Timed unmute";

      // Confirm the action to the moderator
      msg.channel.createMessage(
        successMessage(
          `Unmuting **${args.member.user.username}#${args.member.user.discriminator}** in ${timeUntilUnmute}`
        )
      );
    } else {
      // Otherwise remove "muted" role immediately
      this.serverLogs.ignoreLog(LogType.MEMBER_ROLE_REMOVE, args.member.id);
      await this.actions.fire("unmute", { member: args.member });

      // Confirm the action to the moderator
      msg.channel.createMessage(
        successMessage(`Unmuted **${args.member.user.username}#${args.member.user.discriminator}**`)
      );
    }

    // Create a case
    await this.actions.fire("createCase", {
      userId: args.member.id,
      modId: msg.author.id,
      type: CaseTypes.Unmute,
      reason: args.reason
    });

    // Log the action
    this.serverLogs.log(LogType.MEMBER_UNMUTE, {
      mod: stripObjectToScalars(msg.member.user),
      member: stripObjectToScalars(args.member, ["user"])
    });
  }

  @d.command("mutes")
  @d.permission("view")
  async mutesCmd(msg: Message) {
    this.actions.fire("postMuteList", msg.channel);
  }

  @d.command("kick", "<member:Member> [reason:string$]")
  @d.permission("kick")
  async kickCmd(msg, args: { member: Member; reason: string }) {
    // Make sure we're allowed to kick this member
    if (!this.canActOn(msg.member, args.member)) {
      msg.channel.createMessage(errorMessage("Cannot kick: insufficient permissions"));
      return;
    }

    // Attempt to message the user *before* kicking them, as doing it after may not be possible
    let messageSent = true;
    if (args.reason) {
      const kickMessage = formatTemplateString(this.configValue("kick_message"), {
        guildName: this.guild.name,
        reason: args.reason
      });

      messageSent = await this.tryToMessageUser(
        args.member.user,
        kickMessage,
        this.configValue("dm_on_kick"),
        this.configValue("message_on_kick")
      );
    }

    // Kick the user
    this.serverLogs.ignoreLog(LogType.MEMBER_KICK, args.member.id);
    this.ignoreEvent(IgnoredEventType.Kick, args.member.id);
    args.member.kick(args.reason);

    // Create a case for this action
    await this.actions.fire("createCase", {
      userId: args.member.id,
      modId: msg.author.id,
      type: CaseTypes.Kick,
      reason: args.reason
    });

    // Confirm the action to the moderator
    let response = `Kicked **${args.member.user.username}#${args.member.user.discriminator}**`;
    if (!messageSent) response += " (failed to message user)";
    msg.channel.createMessage(successMessage(response));

    // Log the action
    this.serverLogs.log(LogType.MEMBER_KICK, {
      mod: stripObjectToScalars(msg.member.user),
      user: stripObjectToScalars(args.member.user)
    });
  }

  @d.command("ban", "<member:Member> [reason:string$]")
  @d.permission("ban")
  async banCmd(msg, args) {
    // Make sure we're allowed to ban this member
    if (!this.canActOn(msg.member, args.member)) {
      msg.channel.createMessage(errorMessage("Cannot ban: insufficient permissions"));
      return;
    }

    // Attempt to message the user *before* banning them, as doing it after may not be possible
    let messageSent = true;
    if (args.reason) {
      const banMessage = formatTemplateString(this.configValue("ban_message"), {
        guildName: this.guild.name,
        reason: args.reason
      });

      messageSent = await this.tryToMessageUser(
        args.member.user,
        banMessage,
        this.configValue("dm_on_ban"),
        this.configValue("message_on_ban")
      );
    }

    // Ban the user
    this.serverLogs.ignoreLog(LogType.MEMBER_BAN, args.member.id);
    this.ignoreEvent(IgnoredEventType.Ban, args.member.id);
    args.member.ban(1, args.reason);

    // Create a case for this action
    await this.actions.fire("createCase", {
      userId: args.member.id,
      modId: msg.author.id,
      type: CaseTypes.Ban,
      reason: args.reason
    });

    // Confirm the action to the moderator
    let response = `Banned **${args.member.user.username}#${args.member.user.discriminator}**`;
    if (!messageSent) response += " (failed to message user)";
    msg.channel.createMessage(successMessage(response));

    // Log the action
    this.serverLogs.log(LogType.MEMBER_BAN, {
      mod: stripObjectToScalars(msg.member.user),
      member: stripObjectToScalars(args.member, ["user"])
    });
  }

  @d.command("softban", "<member:Member> [reason:string$]")
  @d.permission("ban")
  async softbanCmd(msg, args) {
    // Make sure we're allowed to ban this member
    if (!this.canActOn(msg.member, args.member)) {
      msg.channel.createMessage(errorMessage("Cannot ban: insufficient permissions"));
      return;
    }

    // Softban the user = ban, and immediately unban
    this.serverLogs.ignoreLog(LogType.MEMBER_BAN, args.member.id);
    this.serverLogs.ignoreLog(LogType.MEMBER_UNBAN, args.member.id);
    this.ignoreEvent(IgnoredEventType.Ban, args.member.id);
    this.ignoreEvent(IgnoredEventType.Unban, args.member.id);

    await args.member.ban(1, args.reason);
    await this.guild.unbanMember(args.member.id);

    // Create a case for this action
    await this.actions.fire("createCase", {
      userId: args.member.id,
      modId: msg.author.id,
      type: CaseTypes.Softban,
      reason: args.reason
    });

    // Confirm the action to the moderator
    msg.channel.createMessage(
      successMessage(`Softbanned **${args.member.user.username}#${args.member.user.discriminator}**`)
    );

    // Log the action
    this.serverLogs.log(LogType.MEMBER_SOFTBAN, {
      mod: stripObjectToScalars(msg.member.user),
      member: stripObjectToScalars(args.member, ["user"])
    });
  }

  @d.command("unban", "<userId:userId> [reason:string$]")
  @d.permission("ban")
  async unbanCmd(msg: Message, args: { userId: string; reason: string }) {
    this.serverLogs.ignoreLog(LogType.MEMBER_UNBAN, args.userId);

    try {
      this.ignoreEvent(IgnoredEventType.Unban, args.userId);
      await this.guild.unbanMember(args.userId);
    } catch (e) {
      msg.channel.createMessage(errorMessage("Failed to unban member"));
      return;
    }

    // Confirm the action
    msg.channel.createMessage(successMessage("Member unbanned!"));

    // Create a case
    await this.actions.fire("createCase", {
      userId: args.userId,
      modId: msg.author.id,
      type: CaseTypes.Unban,
      reason: args.reason
    });

    // Log the action
    this.serverLogs.log(LogType.MEMBER_UNBAN, {
      mod: stripObjectToScalars(msg.member.user),
      userId: args.userId
    });
  }

  @d.command("forceban", "<userId:userId> [reason:string$]")
  @d.permission("ban")
  async forcebanCmd(msg: Message, args: any) {
    // If the user exists as a guild member, make sure we can act on them first
    const member = this.guild.members.get(args.userId);
    if (member && !this.canActOn(msg.member, member)) {
      msg.channel.createMessage(errorMessage("Cannot forceban this user: insufficient permissions"));
      return;
    }

    this.ignoreEvent(IgnoredEventType.Ban, args.userId);
    this.serverLogs.ignoreLog(LogType.MEMBER_BAN, args.userId);

    try {
      await this.guild.banMember(args.userId, 1, args.reason);
    } catch (e) {
      msg.channel.createMessage(errorMessage("Failed to forceban member"));
      return;
    }

    // Confirm the action
    msg.channel.createMessage(successMessage("Member forcebanned!"));

    // Create a case
    await this.actions.fire("createCase", {
      userId: args.userId,
      modId: msg.author.id,
      type: CaseTypes.Ban,
      reason: args.reason
    });

    // Log the action
    this.serverLogs.log(LogType.MEMBER_FORCEBAN, {
      mod: stripObjectToScalars(msg.member.user),
      userId: args.userId
    });
  }

  @d.command("massban", "<userIds:string...>")
  @d.permission("massban")
  @d.nonBlocking()
  async massbanCmd(msg: Message, args: { userIds: string[] }) {
    // Limit to 100 users at once (arbitrary?)
    if (args.userIds.length > 100) {
      msg.channel.createMessage(errorMessage(`Can only massban max 100 users at once`));
      return;
    }

    // Ask for ban reason (cleaner this way instead of trying to cram it into the args)
    msg.channel.createMessage("Ban reason? `cancel` to cancel");
    const banReasonReply = await waitForReply(this.bot, msg.channel as TextChannel, msg.author.id);
    if (!banReasonReply || !banReasonReply.content || banReasonReply.content.toLowerCase().trim() === "cancel") {
      msg.channel.createMessage("Cancelled");
      return;
    }

    const banReason = banReasonReply.content;

    // Verify we can act on each of the users specified
    for (const userId of args.userIds) {
      const member = this.guild.members.get(userId);
      if (member && !this.canActOn(msg.member, member)) {
        msg.channel.createMessage(errorMessage("Cannot massban one or more users: insufficient permissions"));
        return;
      }
    }

    // Ignore automatic ban cases and logs for these users
    // We'll create our own cases below and post a single "mass banned" log instead
    args.userIds.forEach(userId => {
      // Use longer timeouts since this can take a while
      this.ignoreEvent(IgnoredEventType.Ban, userId, 120 * 1000);
      this.serverLogs.ignoreLog(LogType.MEMBER_BAN, userId, 120 * 1000);
    });

    // Show a loading indicator since this can take a while
    const loadingMsg = await msg.channel.createMessage("Banning...");

    // Ban each user and count failed bans (if any)
    const failedBans = [];
    for (const userId of args.userIds) {
      try {
        await this.guild.banMember(userId);

        await this.actions.fire("createCase", {
          userId,
          modId: msg.author.id,
          type: CaseTypes.Ban,
          reason: `Mass ban: ${banReason}`,
          postInCaseLog: false
        });
      } catch (e) {
        failedBans.push(userId);
      }
    }

    // Clear loading indicator
    loadingMsg.delete();

    const successfulBanCount = args.userIds.length - failedBans.length;
    if (successfulBanCount === 0) {
      // All bans failed - don't create a log entry and notify the user
      msg.channel.createMessage(errorMessage("All bans failed. Make sure the IDs are valid."));
    } else {
      // Some or all bans were successful. Create a log entry for the mass ban and notify the user.
      this.serverLogs.log(LogType.MASSBAN, {
        mod: stripObjectToScalars(msg.author),
        count: successfulBanCount
      });

      if (failedBans.length) {
        msg.channel.createMessage(
          successMessage(`Banned ${successfulBanCount} users, ${failedBans.length} failed: ${failedBans.join(" ")}`)
        );
      } else {
        msg.channel.createMessage(successMessage(`Banned ${successfulBanCount} users successfully`));
      }
    }
  }

  @d.command("addcase", "<type:string> <target:userId> [reason:string$]")
  @d.permission("addcase")
  async addcaseCmd(msg: Message, args: any) {
    // Verify the user id is a valid snowflake-ish
    if (!args.target.match(/^[0-9]{17,20}$/)) {
      msg.channel.createMessage(errorMessage("Cannot add case: invalid user id"));
      return;
    }

    // If the user exists as a guild member, make sure we can act on them first
    const member = this.guild.members.get(args.userId);
    if (member && !this.canActOn(msg.member, member)) {
      msg.channel.createMessage(errorMessage("Cannot add case on this user: insufficient permissions"));
      return;
    }

    // Verify the case type is valid
    const type: string = args.type[0].toUpperCase() + args.type.slice(1).toLowerCase();
    if (!CaseTypes[type]) {
      msg.channel.createMessage(errorMessage("Cannot add case: invalid case type"));
      return;
    }

    // Create the case
    const theCase: Case = await this.actions.fire("createCase", {
      userId: args.target,
      modId: msg.author.id,
      type: CaseTypes[type],
      reason: args.reason
    });

    msg.channel.createMessage(successMessage("Case created!"));

    // Log the action
    this.serverLogs.log(LogType.CASE_CREATE, {
      mod: stripObjectToScalars(msg.member.user),
      userId: args.userId,
      caseNum: theCase.case_number,
      caseType: type.toUpperCase()
    });
  }

  /**
   * Display a case or list of cases
   * If the argument passed is a case id, display that case
   * If the argument passed is a user id, show all cases on that user
   */
  @d.command(/showcase|case/, "<caseNumber:number>")
  @d.permission("view")
  async showcaseCmd(msg: Message, args: { caseNumber: number }) {
    // Assume case id
    const theCase = await this.cases.findByCaseNumber(args.caseNumber);

    if (!theCase) {
      msg.channel.createMessage(errorMessage("Case not found"));
      return;
    }

    await this.actions.fire("postCase", {
      caseId: theCase.id,
      channel: msg.channel
    });
  }

  @d.command(/cases|usercases/, "<userId:userId> [expanded:string]")
  @d.permission("view")
  async usercasesCmd(msg: Message, args: { userId: string; expanded?: string }) {
    const cases = await this.cases.with("notes").getByUserId(args.userId);
    const user = this.bot.users.get(args.userId);
    const userName = user ? `${user.username}#${user.discriminator}` : "Unknown#0000";
    const prefix = this.knub.getGuildData(this.guildId).config.prefix;

    if (cases.length === 0) {
      msg.channel.createMessage("No cases found for the specified user!");
    } else {
      if (args.expanded && args.expanded.startsWith("expand")) {
        if (cases.length > 8) {
          msg.channel.createMessage("Too many cases for expanded view. Please use compact view instead.");
          return;
        }

        // Expanded view (= individual case embeds)
        for (const theCase of cases) {
          await this.actions.fire("postCase", {
            caseId: theCase.id,
            channel: msg.channel
          });
        }
      } else {
        // Compact view (= regular message with a preview of each case)
        const lines = [];
        for (const theCase of cases) {
          theCase.notes.sort((a, b) => (a.created_at > b.created_at ? 1 : -1));
          const firstNote = theCase.notes[0];
          let reason = firstNote ? firstNote.body : "";

          if (reason.length > CASE_LIST_REASON_MAX_LENGTH) {
            const match = reason.slice(CASE_LIST_REASON_MAX_LENGTH, 20).match(/(?:[.,!?\s]|$)/);
            const nextWhitespaceIndex = match ? CASE_LIST_REASON_MAX_LENGTH + match.index : CASE_LIST_REASON_MAX_LENGTH;
            if (nextWhitespaceIndex < reason.length) {
              reason = reason.slice(0, nextWhitespaceIndex - 1) + "...";
            }
          }

          reason = disableLinkPreviews(reason);

          lines.push(`Case \`#${theCase.case_number}\` __${CaseTypes[theCase.type]}__ ${reason}`);
        }

        const finalMessage = trimLines(`
        Cases for **${userName}**:

        ${lines.join("\n")}

        Use \`${prefix}case <num>\` to see more info about individual cases
      `);

        const finalMessageChunks = chunkMessageLines(finalMessage);
        for (const msgChunk of finalMessageChunks) {
          msg.channel.createMessage(msgChunk);
        }
      }
    }
  }

  /**
   * Attempts to message the specified user through DMs and/or the message channel.
   * Returns a promise that resolves to a boolean indicating whether we were able to message them or not.
   */
  protected async tryToMessageUser(user: User, str: string, useDM: boolean, useChannel: boolean): Promise<boolean> {
    let messageSent = false;

    if (!useDM && !useChannel) {
      return true;
    }

    if (useDM) {
      try {
        const dmChannel = await this.bot.getDMChannel(user.id);
        await dmChannel.createMessage(str);
        messageSent = true;
      } catch (e) {} // tslint:disable-line
    }

    if (useChannel && this.configValue("message_channel")) {
      try {
        const channel = this.guild.channels.get(this.configValue("message_channel")) as TextChannel;
        await channel.createMessage(`<@!${user.id}> ${str}`);
        messageSent = true;
      } catch (e) {} // tslint:disable-line
    }

    return messageSent;
  }
}
