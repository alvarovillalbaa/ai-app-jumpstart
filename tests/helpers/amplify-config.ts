import type { AmplifyConfig } from "../../lib/deploy/amplify-config";

export function filledAmplifyConfig(): AmplifyConfig {
  return {
    stackName: "jumpstart-fixture", account: "123456789012", region: "eu-west-1",
    appOrigin: "https://app.jumpstart-fixture.dev", eveOrigin: "https://eve.jumpstart-fixture.dev",
    certificateArn: "arn:aws:acm:us-east-1:123456789012:certificate/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    originGuardSecretArn: "arn:aws:secretsmanager:eu-west-1:123456789012:secret:origin-fixture-Abcdef",
    dataProvider: "supabase", supabaseAuthUrl: "https://fixture.supabase.co",
    supabasePublishableKey: "sb_publishable_fixture_public_only_12345678",
    supabaseUrl: "https://fixture.supabase.co", chatEnabled: false,
    secrets: {
      SUPABASE_SECRET_KEY: "arn:aws:secretsmanager:eu-west-1:123456789012:secret:backend-fixture-Abcdef",
      CRON_SECRET: "arn:aws:secretsmanager:eu-west-1:123456789012:secret:cron-fixture-Abcdef",
    },
  };
}
