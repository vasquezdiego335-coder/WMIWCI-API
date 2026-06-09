import { SlashCommandBuilder, ChatInputCommandInteraction, PermissionFlagsBits, ChannelType } from "discord.js";

export const data = new SlashCommandBuilder()
  .setName("setup_business")
  .setDescription("Set up all channels and categories for the moving business server.")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.reply({ content: "Setting up your business server…", ephemeral: true });

  const guild = interaction.guild;
  if (!guild) return;

  // Categories
  const adminCategory = await guild.channels.create({
    name: "📌 ADMIN",
    type: ChannelType.GuildCategory
  });

  const moneyCategory = await guild.channels.create({
    name: "💰 MONEY & NUMBERS",
    type: ChannelType.GuildCategory
  });

  const leadsCategory = await guild.channels.create({
    name: "📈 LEADS & PIPELINE",
    type: ChannelType.GuildCategory
  });

  const opsCategory = await guild.channels.create({
    name: "🚚 OPERATIONS",
    type: ChannelType.GuildCategory
  });

  const generalCategory = await guild.channels.create({
    name: "💬 GENERAL",
    type: ChannelType.GuildCategory
  });

  // ADMIN
  await guild.channels.create({
    name: "llc-paperwork",
    type: ChannelType.GuildText,
    parent: adminCategory.id
  });

  await guild.channels.create({
    name: "taxes-and-legal",
    type: ChannelType.GuildText,
    parent: adminCategory.id
  });

  await guild.channels.create({
    name: "business-plans",
    type: ChannelType.GuildText,
    parent: adminCategory.id
  });

  // MONEY & NUMBERS
  await guild.channels.create({
    name: "profit-tracking",
    type: ChannelType.GuildText,
    parent: moneyCategory.id
  });

  await guild.channels.create({
    name: "expenses",
    type: ChannelType.GuildText,
    parent: moneyCategory.id
  });

  await guild.channels.create({
    name: "40-30-30-calculator",
    type: ChannelType.GuildText,
    parent: moneyCategory.id
  });

  // LEADS & PIPELINE
  await guild.channels.create({
    name: "leads",
    type: ChannelType.GuildText,
    parent: leadsCategory.id
  });

  await guild.channels.create({
    name: "potential-leads",
    type: ChannelType.GuildText,
    parent: leadsCategory.id
  });

  await guild.channels.create({
    name: "closed-deals",
    type: ChannelType.GuildText,
    parent: leadsCategory.id
  });

  // OPERATIONS
  await guild.channels.create({
    name: "today-jobs",
    type: ChannelType.GuildText,
    parent: opsCategory.id
  });

  await guild.channels.create({
    name: "tomorrow-jobs",
    type: ChannelType.GuildText,
    parent: opsCategory.id
  });

  await guild.channels.create({
    name: "job-notes",
    type: ChannelType.GuildText,
    parent: opsCategory.id
  });

  // GENERAL
  await guild.channels.create({
    name: "general",
    type: ChannelType.GuildText,
    parent: generalCategory.id
  });

  await guild.channels.create({
    name: "ideas",
    type: ChannelType.GuildText,
    parent: generalCategory.id
  });

  await interaction.editReply("✅ Your business server structure is set up.");
}
