
S3BUCKET_NAME=$S3BUCKET
LOGPREFIX=logs/spark-operator/

echo "Using the following S3 Bucket: ${S3BUCKET_NAME} ..."

echo "Creating prefix $LOGPREFIX ..."
aws s3api put-object --bucket $S3BUCKET_NAME --key $LOGPREFIX

appnum=$(kubectl get sparkapplication -n data-team-a -o name | grep -i spark-pi | wc -l)

if [ $appnum -gt 0 ]; then
  kubectl delete sparkapplication spark-pi -n data-team-a
fi
 
cat <<EOF >emr-spark-operator-example.yaml
---
apiVersion: "sparkoperator.k8s.io/v1beta2"
kind: SparkApplication
metadata:
  name: spark-pi
  namespace: data-team-a
spec:
  type: Python
  pythonVersion: "3"
  mode: cluster
  # EMR optimized runtime image
  image: "public.ecr.aws/emr-on-eks/spark/emr-7.9.0:latest"
  imagePullPolicy: Always
  mainClass: ValueZones
  mainApplicationFile: s3://aws-data-analytics-workshops/emr-eks-workshop/scripts/pi.py
  hadoopConf:
    # EMRFS filesystem config
    fs.s3.customAWSCredentialsProvider: com.amazonaws.auth.WebIdentityTokenCredentialsProvider
    fs.s3.impl: com.amazon.ws.emr.hadoop.fs.EmrFileSystem
    fs.AbstractFileSystem.s3.impl: org.apache.hadoop.fs.s3.EMRFSDelegate
    fs.s3.buffer.dir: /mnt/s3
    fs.s3.getObject.initialSocketTimeoutMilliseconds: "2000"
    mapreduce.fileoutputcommitter.algorithm.version.emr_internal_use_only.EmrFileSystem: "2"
    mapreduce.fileoutputcommitter.cleanup-failures.ignored.emr_internal_use_only.EmrFileSystem: "true"
  sparkConf:
    # Logging location
    spark.eventLog.enabled: "true"
    spark.eventLog.dir: "s3://$S3BUCKET_NAME/$LOGPREFIX"
    # Required for EMR Runtime and Glue Catalogue
    spark.driver.extraClassPath: /usr/lib/hadoop-lzo/lib/*:/usr/lib/hadoop/hadoop-aws.jar:/usr/share/aws/aws-java-sdk/*:/usr/share/aws/emr/emrfs/conf:/usr/share/aws/emr/emrfs/lib/*:/usr/share/aws/emr/emrfs/auxlib/*:/usr/share/aws/emr/security/conf:/usr/share/aws/emr/security/lib/*:/usr/share/aws/hmclient/lib/aws-glue-datacatalog-spark-client.jar:/usr/share/java/Hive-JSON-Serde/hive-openx-serde.jar:/usr/share/aws/sagemaker-spark-sdk/lib/sagemaker-spark-sdk.jar:/home/hadoop/extrajars/*
    spark.driver.extraLibraryPath: /usr/lib/hadoop/lib/native:/usr/lib/hadoop-lzo/lib/native:/docker/usr/lib/hadoop/lib/native:/docker/usr/lib/hadoop-lzo/lib/native
    spark.executor.extraClassPath: /usr/lib/hadoop-lzo/lib/*:/usr/lib/hadoop/hadoop-aws.jar:/usr/share/aws/aws-java-sdk/*:/usr/share/aws/emr/emrfs/conf:/usr/share/aws/emr/emrfs/lib/*:/usr/share/aws/emr/emrfs/auxlib/*:/usr/share/aws/emr/security/conf:/usr/share/aws/emr/security/lib/*:/usr/share/aws/hmclient/lib/aws-glue-datacatalog-spark-client.jar:/usr/share/java/Hive-JSON-Serde/hive-openx-serde.jar:/usr/share/aws/sagemaker-spark-sdk/lib/sagemaker-spark-sdk.jar:/home/hadoop/extrajars/*
    spark.executor.extraLibraryPath: /usr/lib/hadoop/lib/native:/usr/lib/hadoop-lzo/lib/native:/docker/usr/lib/hadoop/lib/native:/docker/usr/lib/hadoop-lzo/lib/native
    # EMRFS commiter
    spark.sql.parquet.output.committer.class: com.amazon.emr.committer.EmrOptimizedSparkSqlParquetOutputCommitter
    spark.sql.parquet.fs.optimized.committer.optimization-enabled: "true"
    spark.sql.emr.internal.extensions: com.amazonaws.emr.spark.EmrSparkSessionExtensions
    spark.executor.defaultJavaOptions: -verbose:gc -XX:+PrintGCDetails -XX:+PrintGCDateStamps -XX:+UseParallelGC -XX:InitiatingHeapOccupancyPercent=70 -XX:OnOutOfMemoryError='kill -9 %p'
    spark.driver.defaultJavaOptions:  -XX:OnOutOfMemoryError='kill -9 %p' -XX:+UseParallelGC -XX:InitiatingHeapOccupancyPercent=70
  sparkVersion: "3.5.5"
  restartPolicy:
    type: Never
  driver:
    cores: 1
    memory: "2g"
    serviceAccount: spark-operator-emr-job-execution-sa
  executor:
    cores: 2
    instances: 2
    memory: "2g"
    serviceAccount: spark-operator-emr-job-execution-sa
EOF

kubectl apply -f emr-spark-operator-example.yaml