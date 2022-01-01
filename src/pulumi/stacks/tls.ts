import * as pulumi from '@pulumi/pulumi'
import * as k8s from '@pulumi/kubernetes'
import { CertManagerCertificate } from '../component-resources/cluster-svc'

interface TlsStackArgs {
  awsRegion: string,
  emissaryNamespaceName: string,
  certManagerNamespaceName: string,
  acmeEmail: string,
  hostnames: string[],
  rootDomainTlsSecretName: string,
  subdomainWildcardTlsSecretName: string,
}

export class TlsStack extends pulumi.ComponentResource {
  constructor(name: string, args: TlsStackArgs, opts?: pulumi.ComponentResourceOptions) {
    super('custom:stack:TlsStack', name, {}, opts)

    const {
      awsRegion,
      emissaryNamespaceName,
      certManagerNamespaceName,
      acmeEmail,
      hostnames,
      rootDomainTlsSecretName,
      subdomainWildcardTlsSecretName,
    } = args

    /**
    * Set up ClusterIssuer (cluster level tls issuer)
    */
    const clusterIssuer = new k8s.apiextensions.CustomResource(`letsencrypt-cluster-issuer`, {
      apiVersion: 'cert-manager.io/v1',
      kind: 'ClusterIssuer',
      metadata: {
        name: 'letsencrypt-dns-issuer',
        namespace: certManagerNamespaceName,
      },
      spec: {
        acme: {
          // Let's Encrypt will use this to contact you about expiring
          // certificates, and issues related to your account.
          email: acmeEmail,
          // server: 'https://acme-staging-v02.api.letsencrypt.org/directory',
          server: 'https://acme-v02.api.letsencrypt.org/directory',
          privateKeySecretRef: {
            // Secret resource that will be used to store the account's private key.
            name: 'letsencrypt-pk-secret',
          },
          solvers: [{
            selector: {
              dnsZones: hostnames
            },
            dns01: {
              route53: {
                region: awsRegion,
              }
            }
          }]
        }
      }
    }, { parent: this })

    hostnames.forEach(hostname => {
      /**
       * Issue a Certificate for root domain
       */
      const rootDomainCert = new CertManagerCertificate('root-domain-cert', {
        namespace: emissaryNamespaceName,
        dnsName: hostname,
        tlsSecretName: rootDomainTlsSecretName,
      }, { parent: this, dependsOn: [clusterIssuer] })

      /**
       * Issue a Certificate for wildcard subdomains
       */
      const subdomainWildcardCert = new CertManagerCertificate('subdomain-wildcard-cert', {
        namespace: emissaryNamespaceName,
        dnsName: `*.${hostname}`,
        tlsSecretName: subdomainWildcardTlsSecretName,
      }, { parent: this, dependsOn: [clusterIssuer] })
    })

    this.registerOutputs()
  }
}