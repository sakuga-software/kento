---
"@kento-review/web": patch
---

**Azure OpenAI and Claude on Amazon Bedrock** (KNT-206): two more presets on "Add a provider".
Azure OpenAI uses the v1 API of a resource (`https://{resource}.openai.azure.com/openai/v1`), the
key of the resource, and the GPT-6 models under the names of their deployments. Claude on Bedrock is
a provider of the kind Anthropic (`https://bedrock-runtime.{region}.amazonaws.com/anthropic`) with a
long-term Bedrock API key and the global ids of Claude, priced as Anthropic, 10 % more for a
geography. The form asks to replace the placeholder of the URL. A 429 of Azure OpenAI is now a rate
limit that the review waits for, not a usage limit that stops it. No migration, no new kind, and no
change of the protocol of the runners.
