import { z } from "zod";
import { ROUTING_MODES } from "../../../../packages/shared/src/types";
import { storedTaskOrchestrationPlanSchema } from "../../../../packages/shared/src/orchestration-contract";
import type { ExpressIngressAdapter } from "./types";

const createJobSchema = z
  .object({
    rawPrompt: z.string().min(1).optional(),
    prompt: z.string().min(1).optional(),
    displayTitle: z.string().trim().min(1).max(120).optional(),
    orchestrationPlan: storedTaskOrchestrationPlanSchema.optional(),
    conversationId: z.string().trim().min(1).max(200).optional(),
    sourceMessageId: z.string().trim().min(1).max(200).optional(),
    workdir: z.string().max(1000).optional(),
    routingMode: z.enum(ROUTING_MODES).optional(),
    maxModelCalls: z.number().int().min(1).max(100).optional(),
    classicFinalGateEnabled: z.boolean().optional(),
    discussionRounds: z.number().int().min(1).max(10).optional(),
    requesterId: z.string().optional()
  })
  .refine((input) => input.rawPrompt || input.prompt, {
    message: "rawPrompt or prompt is required",
    path: ["rawPrompt"]
  });

export const httpIngressAdapter: ExpressIngressAdapter = {
  name: "http",
  isEnabled: () => true,
  mount(app, deps) {
    app.post("/jobs", async (request, response, next) => {
      try {
        const input = createJobSchema.parse(request.body);
        const job = await deps.createJob({
          rawPrompt: input.rawPrompt ?? input.prompt ?? "",
          displayTitle: input.displayTitle,
          orchestrationPlan: input.orchestrationPlan,
          conversationId: input.conversationId,
          sourceMessageId: input.sourceMessageId,
          workdir: input.workdir,
          ingressOrigin: "http",
          routingMode: input.routingMode,
          maxModelCalls: input.maxModelCalls,
          classicFinalGateEnabled: input.classicFinalGateEnabled,
          discussionRounds: input.discussionRounds,
          requesterId: input.requesterId
        });
        const started = await deps.startJob(job);

        response.status(201).json({
          jobId: job.id,
          displayTitle: job.displayTitle,
          orchestrationSource: job.orchestrationSource,
          ingressOrigin: job.ingressOrigin,
          routingMode: job.routingMode,
          maxModelCalls: job.maxModelCalls,
          classicFinalGateEnabled: job.classicFinalGateEnabled,
          discussionRounds: job.discussionRounds,
          status: started.status,
          workflowId: started.workflowId,
          preflight: started.preflight
        });
      } catch (error) {
        next(error);
      }
    });
  }
};
