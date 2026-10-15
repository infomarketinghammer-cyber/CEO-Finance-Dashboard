import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../db/index.js';
import { env } from '../../config/env.js';
import { asyncHandler } from '../../middleware/error.js';
import { authenticate, requireCapability, resolveCompany } from '../../middleware/auth.js';
import { notConfigured } from '../../lib/errors.js';
import { computeProfitAndLoss } from '../finance/statements.js';
import { resolvePeriod } from '../finance/periods.js';
import { percentOf, sub, type Minor } from '../../lib/money.js';

export const aiRouter = Router();
aiRouter.use(authenticate);

/**
 * AI-assisted insight layer.
 *
 * No AI provider ships configured, and this module never pretends otherwise. What
 * it does provide is a deterministic narrative built arithmetically from the same
 * calculation service everything else uses — clearly labelled as calculated fact
 * rather than interpretation.
 *
 * The separation matters: every statement under `facts` is reproducible from the
 * ledgers. Nothing in this file invents an amount, and no AI layer, once added,
 * will be permitted to modify accounting records or mappings.
 */

function providerStatus() {
  const configured = Boolean(env.integrations.aiProvider && env.integrations.aiApiKey);
  return {
    configured,
    provider: configured ? env.integrations.aiProvider : null,
    status: configured
      ? `Configured with ${env.integrations.aiProvider}.`
      : 'Not configured. Set AI_PROVIDER and AI_API_KEY in the server environment to enable AI-written commentary.',
    capabilitiesWithoutProvider: [
      'Calculated plain-language summaries of what changed and by how much',
      'Period-on-period variance with the arithmetic shown',
    ],
    capabilitiesRequiringProvider: [
      'Narrative commentary and recommendations',
      'Free-form questions about the financial data',
      'Explanations written in context rather than from a template',
    ],
    guarantees: [
      'AI output can never create, change or delete an accounting record or an account mapping.',
      'AI output is always presented separately from calculated figures.',
      'AI requests are scoped to the companies the signed-in user may already access.',
    ],
  };
}

aiRouter.get(
  '/status',
  requireCapability('ai.use'),
  asyncHandler(async (_req, res) => {
    res.json(providerStatus());
  }),
);

/**
 * A calculated summary. Every sentence is derived arithmetically, so this works
 * whether or not an AI provider is configured.
 */
aiRouter.get(
  '/summary',
  requireCapability('ai.use'),
  resolveCompany,
  asyncHandler(async (req, res) => {
    const resolved = await resolvePeriod({
      companyId: req.companyId!,
      financialYearId: (req.query.financialYearId as string) || null,
      periodType: (req.query.periodType as string) || 'financial_year',
      from: req.query.from as string,
      to: req.query.to as string,
    });

    const company = await db('companies').where({ id: req.companyId }).first();

    const pl = await computeProfitAndLoss(req.companyId!, resolved.period, {
      financialYearId: resolved.financialYearId,
      comparison: { period: resolved.previousPeriod, label: 'Previous period' },
    });

    const facts: { statement: string; basis: string }[] = [];

    const fmt = (m: Minor | null) =>
      m === null ? 'not available' : `₹${(m / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;

    if (pl.isEmpty) {
      facts.push({
        statement: `No Profit & Loss activity has been recorded for ${company.name} in ${resolved.period.label}.`,
        basis: 'No ledger categorised under a Profit & Loss section carries a movement in this period.',
      });
    } else {
      const revenueLine = pl.lines.find((l) => l.key === 'revenue');
      const netLine = pl.lines.find((l) => l.key === 'netProfit');
      const opexLine = pl.lines.find((l) => l.key === 'opex');

      facts.push({
        statement: `Revenue for ${resolved.period.label} is ${fmt(pl.revenue)}.`,
        basis: 'Sum of ledgers categorised as Revenue over the period.',
      });

      if (revenueLine?.variance !== null && revenueLine?.variance !== undefined && revenueLine.previousValue) {
        const direction = revenueLine.variance >= 0 ? 'higher' : 'lower';
        facts.push({
          statement: `That is ${fmt(Math.abs(revenueLine.variance))} ${direction} than the previous period (${revenueLine.variancePercent?.toFixed(1)}%).`,
          basis: `Current period revenue minus previous period revenue of ${fmt(revenueLine.previousValue)}.`,
        });
      }

      facts.push({
        statement: `Net profit is ${fmt(pl.netProfit)}, a net margin of ${pl.revenue ? (percentOf(pl.netProfit ?? 0, pl.revenue) ?? 0).toFixed(1) : '—'}%.`,
        basis: 'Profit Before Tax less Tax Expense, divided by Revenue.',
      });

      if (netLine?.variance !== null && netLine?.variance !== undefined && netLine.previousValue) {
        facts.push({
          statement: `Net profit moved by ${fmt(netLine.variance)} against the previous period.`,
          basis: `Current ${fmt(netLine.value)} less previous ${fmt(netLine.previousValue)}.`,
        });
      }

      // Largest expense movement, as a fact rather than a claim about cause.
      const expenseLines = pl.lines.filter(
        (l) => ['cogs', 'direct', 'opex', 'depreciation', 'financeCost', 'otherExpenses'].includes(l.key) && l.variance !== null && l.variance !== undefined,
      );
      const biggest = expenseLines.sort((a, b) => Math.abs(b.variance ?? 0) - Math.abs(a.variance ?? 0))[0];
      if (biggest && biggest.variance) {
        facts.push({
          statement: `The largest expense movement is ${biggest.label}, which changed by ${fmt(biggest.variance)}.`,
          basis: `${biggest.label} this period of ${fmt(biggest.value)} against ${fmt(biggest.previousValue ?? 0)} previously. The figures state the movement; they do not explain its cause.`,
        });
      }

      if (opexLine?.children?.length) {
        const top = [...opexLine.children].sort((a, b) => b.total - a.total)[0];
        if (top) {
          facts.push({
            statement: `The largest operating expense category is ${top.label} at ${fmt(top.total)}.`,
            basis: `Sum of ${top.ledgerCount} ledger(s) categorised under ${top.label}.`,
          });
        }
      }
    }

    if (pl.quality.warnings.length) {
      for (const w of pl.quality.warnings) {
        facts.push({ statement: w, basis: 'Data quality check on account mappings.' });
      }
    }

    res.json({
      period: resolved.period,
      companyName: company.name,
      facts,
      interpretation: null,
      interpretationStatus: providerStatus().configured
        ? 'An AI provider is configured, but narrative generation is not implemented in this version.'
        : 'No AI provider is configured, so no AI-written interpretation is available. Every statement above is calculated arithmetically from your ledgers and is reproducible.',
      provider: providerStatus(),
      disclaimer:
        'These are calculated facts, not interpretation. A change in a figure is reported; the reason behind it is not inferred.',
    });
  }),
);

aiRouter.post(
  '/ask',
  requireCapability('ai.use'),
  resolveCompany,
  asyncHandler(async (req) => {
    z.object({ question: z.string().min(1).max(1000) }).parse(req.body);

    // No provider, no answer. Returning a templated response here would be exactly
    // the pretend-integration §25 forbids.
    throw notConfigured(
      'Natural-language questions need an AI provider, and none is configured. Set AI_PROVIDER and AI_API_KEY in the server environment to enable this.',
      { provider: providerStatus() },
    );
  }),
);

export { sub };
