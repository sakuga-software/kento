// KNT-206. The presets of the clouds of the enterprises: Azure OpenAI and Amazon Bedrock. Each one
// takes a key that lasts: the key of an Azure resource, and a long-term API key of Bedrock. Google
// Vertex AI takes only OAuth tokens that end after one hour, so it is no preset (see KNT-206).
//
// The base URL of each one holds a placeholder (presets.ts, PLACEHOLDERS), and the prices are in
// prices.ts, by the id of the preset.
import type { ProviderPreset } from './presets.ts';

/** The day the docs of the clouds were read. */
const KNT_206 = '2026-11-24';

export const ENTERPRISE_PRESETS: readonly ProviderPreset[] = [
  {
    id: 'azure-openai',
    name: 'Azure OpenAI',
    kind: 'openai_compatible',
    // The v1 API: no `api-version`. The key of the resource goes in `Authorization: Bearer`, as the
    // OpenAI client sends it.
    baseUrl: 'https://{resource}.openai.azure.com/openai/v1',
    otherBaseUrls: ['https://{resource}.services.ai.azure.com/openai/v1', 'https://{resource}.cognitiveservices.azure.com/openai/v1'],
    baseUrlHint:
      'Replace {resource} with the name of your Azure OpenAI or Foundry resource. Each model below is the name of a deployment: deploy each model under its own name, or write the names of your deployments.',
    keysUrl: 'https://ai.azure.com/',
    // The GPT-6 models answer in a strict JSON schema on Chat Completions. They take tools there
    // only with `reasoning_effort: none` (gpt-6-luna, gpt-6-sol, gpt-6.1-terra); the adapter sends
    // no tools to a server of the API of OpenAI.
    models: {
      lite: ['gpt-6-luna'],
      balanced: ['gpt-6.1-terra', 'gpt-6-luna'],
      heavy: ['gpt-6-sol', 'gpt-6.1-terra'],
    },
    modelsSource: { url: 'https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/reasoning', checked: KNT_206 },
    modelsPath: '/models',
    // « Reasoning models will only work with the max_completion_tokens parameter when using the Chat
    // Completions API. »
    maxTokensField: 'max_completion_tokens',
    data: {
      note: 'Azure OpenAI does not give the prompts and the answers to OpenAI, and does not train on them. Its abuse monitoring can keep a flagged sample for a review by a person, in the geography of the resource. A Global deployment can run the request in any geography.',
      url: 'https://learn.microsoft.com/en-us/azure/foundry/responsible-ai/openai/data-privacy',
      checked: KNT_206,
    },
  },
  {
    id: 'bedrock-claude',
    name: 'Amazon Bedrock (Claude)',
    // The Messages API of Anthropic on bedrock-runtime: the key goes in `x-api-key`, with
    // `anthropic-version`, as the adapter of Anthropic sends them.
    kind: 'anthropic',
    baseUrl: 'https://bedrock-runtime.{region}.amazonaws.com/anthropic',
    baseUrlHint:
      'Replace {region} with the AWS Region of your account, for example us-east-1 or eu-west-3. Use a long-term Bedrock API key that ends, on an IAM user that may only call these models.',
    keysUrl: 'https://console.aws.amazon.com/bedrock/home#/api-keys',
    // The global inference profiles: no premium. A geography (`us.`, `eu.`) costs 10 % more.
    models: {
      lite: ['global.anthropic.claude-haiku-5-5'],
      balanced: ['global.anthropic.claude-sonnet-5-5'],
      heavy: ['global.anthropic.claude-opus-5-5'],
    },
    modelsSource: { url: 'https://docs.aws.amazon.com/bedrock/latest/userguide/claude-messages-structured-outputs.html', checked: KNT_206 },
    // bedrock-runtime has no list of the models, and a key limited to the models may not list them.
    modelsPath: null,
    testNote: 'Amazon Bedrock has no call that tests a key for free. The first review tests it.',
    data: {
      note: 'The model provider has no access to the prompts and the answers on Amazon Bedrock. A global model id (global.) can run the request in any commercial AWS Region: an id of a geography (eu., us.) keeps it there.',
      url: 'https://docs.aws.amazon.com/bedrock/latest/userguide/data-protection.html',
      checked: KNT_206,
    },
  },
];
