# Create K8s App
Create a Kubernetes cluster with everything included to run an app.

It's like "Create React App", but for setting up Kubernetes cluster with helpful features preinstalled (node/pod autoscaling, https, monitoring, app serving, etc). It uses Pulumi to programmatically create a Kubernetes cluster and provision all the resources required to serve an app with a single command (almost). ✨

Once the cluster is set up, you can use Pulumi to manage or add resources using the familiar Javascipt/Typescript. Or, you can directly manipulate Kubernetes resources using kubectl or any other tools (e.g. Terraform) if you prefer.

* Currently supports AWS only.
* Currently tested on MacOS.

If something doesn't work, please file an issue.

<!-- If you have questions or need help, please join the [Slack channel](https://create-knative-cluster.slack.com) -->

💕 Any feedback or contribution is welcome and appreciated!


## Overview
If you'd like to get started right away, see [Creating K8s App](#creating-k8s-app) section or [Tutorials](#tutorials) section. Please review the [cost considerations](#cost-considerations) before using this project.

### Motivation
It is far too much work to setup a working Kubernetes cluster with everything required to serve even a simple web app. Despite the introduction of interesting DevOps automation tools like Pulumi:

1. It's common to encounter countless issues and gotchas when putting them all together
2. It's hard to figure out what the best practice is for setting up and managing a Kubernetes cluster via Pulumi

This package aims to remove these frustrations - much like Create React App did for scaffolding a React app.

Underneath, this package uses Dapr and Emissary Ingress (a.k.a. Ambassador) to serve apps. The default setup enables some helpful features such as:

* Autoscaling for both nodes (via Karpenter) and pods (via Horizontal Pod Autoscaler)
* Zero downtime deployment
* Easy rollbacks
* Flexible deployment options such as blue/green or canary deployments
  
### What's included
* AWS EKS cluster with Managed Node Group: Defaults to `t3.medium` instances with disk space of 30GB; 4x desired nodes (i.e. EC2 instances), 4x min nodes, and 20x max nodes
* Karpenter: If there are pods pending due to lack of nodes, Karpenter will automatically spin up more nodes in the cluster
* Custom domain: Use your own custom domain by default
* Https by default: Cert-manager enables https traffic to the cluster with auto-renewed Let's Encrypt certificates
* Emissary Ingress: Emissary Ingress is an API gateway and makes it easy to control routing to services including ingress (i.e. entrypoint) for the cluster
* Monitoring via Kube Prometheus Stack: Monitoring with Prometheus and Grafana is enabled by default. Login to Grafana using the credentials you set with CLI by visiting grafana.your-domain.com
* (Optional) AWS RDS instance
  * Staging DB: Defaults to `db.t3.micro` with 5GB of storage and 50GB of max storage
  * Prod DB: Defaults to `db.t3.small` with 20GB of storage and 1000GB of max storage
* (Optional) App: make sure to change the settings for your use case - consider the default setup as more of an example (built for running a React/Express app)
  * Staging app: routes to `staging.<your-domain>` (i.e. `staging.sidetrek.com`)
  * Prod app: routes to `*.<your-domain>` (i.e. `*.sidetrek.com`)

### <a name="cost-considerations"></a>Cost considerations
This project is completely open-source but the resources it provisions will cost you in potentially two ways.
1. Pulumi: Whether you're on a free or paid plan, the default setup should cost you nothing. On a paid plan, it'll come pretty close as create-knative-cluster will provision 200+ resources.
2. AWS: With 1x EKS cluster (~$70/mo), 4x t3.medium EC2 instances (~$120/mo), the default setup will cost you ~$200/mo. If you use the RDS option, that'll cost you extra depending on your storage requirements.


## <a name="creating-k8s-app"></a>Creating a k8s app

### Prerequisites
1. Install `aws` cli by following the instructions [here](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)
2. Create a Pulumi AWS Typescript project
   * Follow the instructions in [Pulumi docs](https://www.pulumi.com/docs/get-started/aws/begin/) to set up Pulumi and AWS credentials - Pulumi only provides a method for generating a new project in an empty directory, but if you'd like to add Pulumi to an existing project, you can copy over the files and packages to the existing project.
3. Install `kubectl`
4. Install npm dependencies: `npm i @pulumi/aws @pulumi/awsx @pulumi/eks @pulumi/kubernetes @pulumi/kubernetes-cert-manager @pulumi/pulumi`
5. Set up a custom domain
   1. Register a domain - easiest way is to use AWS Route 53 to [register a new custom domain](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/domain-register.html#domain-register-procedure)
   2. If you're using some other DNS provider like GoDaddy, you can either 1) [migrate your domain to Route 53](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/MigratingDNS.html) or 2) create a Hosted zone in Route 53 (domain name must match exactly - e.g. `sidetrek.com`) and taking the created name servers (i.e. records with type `NS`) and replacing it with name servers in your current DNS provider like GoDaddy.
   3. Either way, save the ID of the Hosted zone - you'll need it when you set up the project
6. (Optional - but recommended) Setup `direnv` to enable directory specific kubectl setup if you passed in `--use-direnv` option. This is way, you can use kubectl with multiple projects (i.e. multiple Kubernetes clusters). To install:
   1. Follow the Basic Install in [direnv docs](https://direnv.net/)
   2. Once successfully installed, run `direnv allow .` in the project root directory

### Get started
1. Create ckc-config.json in your project root directory and configure it to your needs.
```
{
  "init": {
    "awsRegion": "us-west-1",
    "pulumiOrganization": "example", // name of your Pulumi organization
    "hostname": "example.com", // Hostname of your custom domain
    "hostedZoneId": "EXAMPLE123" // AWS Route53 Hosted Zone ID for your hostname,
    "acmeEmail": "hello@example.com", // Email to use for Let's Encrypt TLS certificate creation
    "useDirenv": true, // Recommended to scope Kubernetes envs to this particular project directory rather than globally - see direnv setup instruction in Prerequisites section for more details
  },
  "destroy": {
    "removeStacks": true, // remove Pulumi stacks when destroying resources
    "keepCluster": false
  }
}
```
2. If you're using direnv option, make sure to run `direnv allow .` before proceeding.
3. Deploy your app to a Kubernetes cluster (🧘🏼‍♀️ please be patient as the entire process can take 30-60 minutes to complete - provisioning AWS EKS alone can take 20+ minutes).
```
npx ckc init
```
4. Point custom domain to ingress external IP (this is the entry point to the cluster).
   1. Run `kubectl get svc -n emissary` to get the External-IP of `emissary-ingress` Service
   2. Add a CNAME record in Route 53 (or use Alias A record if it's a root domain - i.e. sidetrek.com). In the custom domain's Hosted zone, Create a record with:
      * Record name: *.<your-domain> (i.e. *.sidetrek.com), 
      * Record type: CNAME, and 
      * Value: ingress external IP from the previous step
5. (Optional) Add app related stacks. Please review the settings before running this to fit your use case - use it more as an example.
```
npx ckc app
```
6. (Optional) Run the following cmd to copy the Pulumi setup files for local management
```
npx ckc copy-pulumi-files
```
7. Destroy the entire project
```
npx ckc destroy
```
Options:
```
--keep-cluster: removes all resources except for the cluster, Karpenter, and main k8s roles
```

If you'd like to see the whole project setup from start to finish, please see [tutorials section](#tutorials). 

### (Optional) Set up RDS

### (Optional) Set up a Create React App + Express app
1. Make sure `Dockerfile.prod` is present in the project root dir. This Dockerfile will be used to build and push the image to ECR. 

Here's an example of `Dockerfile.prod` assuming your react app is in `/frontend` dir and `npm run server:prod` runs the Express server (e.g.: `nodemon server/server.js` - of course, make sure you have `nodemon` installed in this case):

```
# For production build, include both api and frontend in the same build

# Build stage
FROM node:16-alpine3.13 AS builder
WORKDIR /app
COPY ./frontend/package*.json ./
RUN npm i
COPY ./frontend .
RUN npm run build

# Production stage
FROM node:16-alpine3.13
WORKDIR /app
# Copy application dependency manifests to the container image.
# A wildcard is used to ensure both package.json AND package-lock.json are copied.
# Copying this separately prevents re-running npm install on every code change.
COPY package*.json ./
RUN npm i
# Copy local code to the container image.
COPY . ./
# Copy static assets from builder stage.
COPY --from=builder /app/build ./build
CMD npm run server:prod
```

Also add `.dockerignore` file in the project root dir:
```
Dockerfile
README.md
node_modules
npm-debug.log
logs
.env*
.env
.env.development
.env.production
kubeconfig*
```

2. Run `npx create-knative-cluster app`

### (Optional) Set up dev
Coming soon

### Customizing the default setup
You can customize the default setup simply by updating the stacks via Pulumi cli once the project setup is complete. 

But be mindful if you want to reduce the default resources allocations (e.g. reducing the minimum number of nodes or downgrading EC2 instance types for the cluster). It could fail to provision resources due to the max number of pods that can be created per EC2 instance type or run out of nodes to allocate Kubernetes pods to.

## Manage resources locally via Pulumi
You can add/update/delete any resources via Pulumi. This project was specifically designed for this use case.

All Pulumi setup files are copied in `/pulumi` folder during project creation. You can alter these files to alter the state of your AWS/Kubernetes resources using Pulumi cli.

Please refer to [Pulumi docs](https://www.pulumi.com/docs/) to learn how to use Pulumi.

[Tutorials section](#tutorials) also covers basic resource management with Pulumi.

## CLI Options
Coming soon

### Passwords
DB password and Granafa password entered via CLI is saved as Secrets (which is by default encrypted) in Pulumi config in their respective stacks.
* To retrieve the original password for DB: `pulumi stack select <db_staging or db_prod stack name>` and then `pulumi config get db_password`
* To retrieve the original password for Grafana: `pulumi stack select <kube_prometheus_stack stack name>` and then `pulumi config get grafana_password`

## Destroying project
You can destroy the entire project (assuming you didn't any more resources) by running:

```
npx create-knative-cluster destroy
```

### Caveats for using this command
* This command will completely destroy the project. This is useful for testing and also for starting with a clean state in case something goes wrong during the installation.
* This command <b>assumes the project was just created</b>. If you've added any new Pulumi stacks, you'll need to manually destroy those stacks first before running this command. Again, this command is built for when the setup process ran into unexpected issues or for testing. Once the project is setup, it's up to you to manage all resources using Pulumi.

### Destroying individual stacks
If you prefer to keep parts of it, you can destroy individual stacks by selecting the stack `pulumi stack select <stack name>` and then running:

```
pulumi destroy
```

You should be very careful when destroying individual stacks. There are dependencies you should be aware of. See "Caveats" section below.

### Caveats
* Dependencies between stacks:
  * Some stacks are dependent on other stacks which means attempting to destroy the parent stack can fail. For example, `cluster` stack will fail to destroy properly if there are resources still existing in the `cluster`. Be mindful of these dependencies - otherwise, you might have to do a lot of manual cleaning of orphaned resources.
  * In general, you should destroy things in this order:
    * App and app related services like RDS which is dependent on cluster services like Knative and Istio, 
    * Cluster services like Istio, Knative, cert-manager, etc, a
    * Finally, the cluster itself if necessary
* Known limitation with `pulumi destroy` for `knative_operator` stack:
  * You need to destroy the `knative_serving` and `knative_eventing` stacks before destroying `knative_operator`.
  * By design, destroying Knative Operator does not remove Knative CRDs (in case the CRDs are used in other resources).

## Rollbacks using Knative
Coming soon

## CD setup via Git Actions
Coming soon

## <a name="tutorials"></a>Tutorials
Coming soon

### Create React App + Express
* TODO: explain react env var setup

### Update existing resources using Pulumi
Coming soon

## Troubleshooting
* If destroy operation fails due to timeout (i.e. waiting for some cloud resource state to become 'destroyed'), then:
  * Destroy the resource manually - i.e. via AWS console or aws/kubectl cli
  * Refresh the Pulumi state (this will make sure Pulumi state is again in sync with cloud state): `pulumi refresh` (make sure you're in the right Pulumi stack)
  * Retry `create-knative-cluster destroy` (or `pulumi destroy` in the stack if destroying manually via Pulumi cli) to destroy the rest of the resources

## <a name="internals"></a>Internals of Create Knative Cluster
This explanation assumes basic understanding of Docker and Kubernetes. If you are not familiar with these topics, there's a lot of great resources on YouTube, such as this great intro series on [Docker](https://youtu.be/3c-iBn73dDE) and [Kubernetes](https://youtu.be/X48VuDVv0do).

### TL;DR
Coming soon

### Mini course
Coming soon

## Simple load testing to verify HPA and Karpenter are working correctly
* `-c`: 2-4x number of cores (or at least `-c 32`)
* `-qps`: 0 to test at max qps for a short period of time (e.g.`-t 30s`) then run at ~75% of that qps (e.g. `-qps 7500` if max qps was 10k)
* `-t`: `-t 5min`

Run the load test (open up a separate terminal window and watch the pods autoscale as load increases: e.g. `kubectl get pods -n app-staging -w`):
```
fortio load https://your-website.com -c 24 -qps 5000 -t 60s -json result.json
```

To See the result:
```
fortio report -json result.json
```