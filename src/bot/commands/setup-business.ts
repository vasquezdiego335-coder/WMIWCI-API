import { SlashCommandBuilder, ChatInputCommandInteraction, PermissionFlagsBits } from "discord.js";

// ════════════════════════════════════════════════════════════════════════
//  /setup_business — RETIRED 2026-09-20.
//  ----------------------------------------------------------------------
//  This command built the ORIGINAL server layout: five categories and
//  seventeen channels (#profit-tracking, #expenses, #taxes-and-legal …) created
//  with NO permission overwrites, i.e. readable by @everyone.
//
//  The server has since been restructured around roles (👑 Owner, 🧭 Manager,
//  🚚 Crew Lead, 📦 Mover) with every private category locked down, and crew
//  are being invited. Running the old body now would recreate all of those
//  finance channels in plain view of every mover.
//
//  The command stays REGISTERED so an owner who remembers it gets an answer
//  instead of "unknown command" — but it creates nothing.
//
//  To check the live server against the access policy:
//      npx tsx scripts/discord-permission-audit.ts
// ════════════════════════════════════════════════════════════════════════

export const data = new SlashCommandBuilder()
  .setName("setup_business")
  .setDescription("Retired — the server layout is managed by the owner-approved access policy.")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.reply({
    content:
      "This command is retired and created nothing.\n" +
      "The server layout (START HERE · OPERATIONS · BUSINESS · MANAGEMENT · ARCHIVE) and its role permissions are already in place. " +
      "Re-running the old setup would recreate the finance channels where every mover could read them.",
    ephemeral: true,
  });
}
