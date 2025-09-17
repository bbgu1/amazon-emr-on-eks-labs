   ARG EMR_VERSION
   
   FROM public.ecr.aws/emr-on-eks/flink/emr-${EMR_VERSION}-flink:latest
   USER root

   ENV FLINK_VERSION "1.20.0"
   ENV MAVEN_VERSION "3.9.11"
  
   ENV HADOOP_VERSION "3.3.3"
   ENV MAVEN_URL=https://dlcdn.apache.org/maven/maven-3/3.9.11/binaries/apache-maven-3.9.11-bin.tar.gz

   RUN yum update -y
   RUN yum group install -y "Development Tools" \
     && yum install -y wget tar \
     && mkdir -p /usr/share/maven

   RUN wget $MAVEN_URL -O /tmp/apache-maven.tar.gz &&         tar -xzf /tmp/apache-maven.tar.gz -C /usr/share/maven --strip-components=1 &&         rm -f /tmp/apache-maven.tar.gz &&         ln -s /usr/share/maven/bin/mvn /usr/bin/mvn

   RUN mkdir -p $FLINK_HOME/usrlib

   RUN git clone https://github.com/norrishuang/emr-eks-flink-java.git /tmp/emr-eks-flink-java \
     &&  cd /tmp/emr-eks-flink-java/  \
     &&  git pull \
     &&  mvn clean install


   RUN cp /tmp/emr-eks-flink-java/target/emr-eks-flink-java-1.0.9.jar $FLINK_HOME/lib/emr-eks-flink-java-1.0.9.jar

   RUN wget https://repo1.maven.org/maven2/org/apache/flink/flink-parquet/${FLINK_VERSION}/flink-parquet-${FLINK_VERSION}.jar -O /lib/flink-parquet-${FLINK_VERSION}.jar &&        wget https://repo1.maven.org/maven2/org/apache/flink/flink-sql-parquet/${FLINK_VERSION}/flink-sql-parquet-${FLINK_VERSION}.jar -O /lib/flink-sql-parquet-$FLINK_VERSION.jar

   # # Use hadoop user and group 
   USER hadoop:hadoop
