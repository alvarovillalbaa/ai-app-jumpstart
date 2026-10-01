import { awsS3Client,awsS3Settings,verifyPrivateS3Bucket } from "../lib/uploads/aws-s3";

try {
  const { region,bucket } = awsS3Settings(process.env);
  await verifyPrivateS3Bucket(awsS3Client(region),bucket);
  console.log("AWS S3 private upload bucket passed public-access and versioning checks.");
} catch {
  // SDK exceptions can contain endpoints, bucket names and credential details.
  console.error("AWS S3 upload storage check failed. Review region, bucket privacy, versioning, credentials and IAM permissions.");
  process.exitCode = 1;
}
