// *** WARNING: this file was generated by crd2pulumi. ***
// *** Do not edit by hand unless you're certain you know what you are doing! ***

import * as pulumi from "@pulumi/pulumi";
import { input as inputs, output as outputs } from "../../types";
import * as utilities from "../../utilities";

import {ObjectMeta} from "../../meta/v1";

/**
 * PodAutoscaler is a Knative abstraction that encapsulates the interface by which Knative components instantiate autoscalers.  This definition is an abstraction that may be backed by multiple definitions.  For more information, see the Knative Pluggability presentation: https://docs.google.com/presentation/d/10KWynvAJYuOEWy69VBa6bHJVCqIsz1TNdEKosNvcpPY/edit
 */
export class PodAutoscaler extends pulumi.CustomResource {
    /**
     * Get an existing PodAutoscaler resource's state with the given name, ID, and optional extra
     * properties used to qualify the lookup.
     *
     * @param name The _unique_ name of the resulting resource.
     * @param id The _unique_ provider ID of the resource to lookup.
     * @param opts Optional settings to control the behavior of the CustomResource.
     */
    public static get(name: string, id: pulumi.Input<pulumi.ID>, opts?: pulumi.CustomResourceOptions): PodAutoscaler {
        return new PodAutoscaler(name, undefined as any, { ...opts, id: id });
    }

    /** @internal */
    public static readonly __pulumiType = 'kubernetes:autoscaling.internal.knative.dev/v1alpha1:PodAutoscaler';

    /**
     * Returns true if the given object is an instance of PodAutoscaler.  This is designed to work even
     * when multiple copies of the Pulumi SDK have been loaded into the same process.
     */
    public static isInstance(obj: any): obj is PodAutoscaler {
        if (obj === undefined || obj === null) {
            return false;
        }
        return obj['__pulumiType'] === PodAutoscaler.__pulumiType;
    }

    public readonly apiVersion!: pulumi.Output<"autoscaling.internal.knative.dev/v1alpha1" | undefined>;
    public readonly kind!: pulumi.Output<"PodAutoscaler" | undefined>;
    public readonly metadata!: pulumi.Output<ObjectMeta | undefined>;
    /**
     * Spec holds the desired state of the PodAutoscaler (from the client).
     */
    public readonly spec!: pulumi.Output<outputs.autoscaling.v1alpha1.PodAutoscalerSpec | undefined>;
    /**
     * Status communicates the observed state of the PodAutoscaler (from the controller).
     */
    public readonly status!: pulumi.Output<outputs.autoscaling.v1alpha1.PodAutoscalerStatus | undefined>;

    /**
     * Create a PodAutoscaler resource with the given unique name, arguments, and options.
     *
     * @param name The _unique_ name of the resource.
     * @param args The arguments to use to populate this resource's properties.
     * @param opts A bag of options that control this resource's behavior.
     */
    constructor(name: string, args?: PodAutoscalerArgs, opts?: pulumi.CustomResourceOptions) {
        let inputs: pulumi.Inputs = {};
        opts = opts || {};
        if (!opts.id) {
            inputs["apiVersion"] = "autoscaling.internal.knative.dev/v1alpha1";
            inputs["kind"] = "PodAutoscaler";
            inputs["metadata"] = args ? args.metadata : undefined;
            inputs["spec"] = args ? args.spec : undefined;
            inputs["status"] = args ? args.status : undefined;
        } else {
            inputs["apiVersion"] = undefined /*out*/;
            inputs["kind"] = undefined /*out*/;
            inputs["metadata"] = undefined /*out*/;
            inputs["spec"] = undefined /*out*/;
            inputs["status"] = undefined /*out*/;
        }
        if (!opts.version) {
            opts = pulumi.mergeOptions(opts, { version: utilities.getVersion()});
        }
        super(PodAutoscaler.__pulumiType, name, inputs, opts);
    }
}

/**
 * The set of arguments for constructing a PodAutoscaler resource.
 */
export interface PodAutoscalerArgs {
    readonly apiVersion?: pulumi.Input<"autoscaling.internal.knative.dev/v1alpha1">;
    readonly kind?: pulumi.Input<"PodAutoscaler">;
    readonly metadata?: pulumi.Input<ObjectMeta>;
    /**
     * Spec holds the desired state of the PodAutoscaler (from the client).
     */
    readonly spec?: pulumi.Input<inputs.autoscaling.v1alpha1.PodAutoscalerSpecArgs>;
    /**
     * Status communicates the observed state of the PodAutoscaler (from the controller).
     */
    readonly status?: pulumi.Input<inputs.autoscaling.v1alpha1.PodAutoscalerStatusArgs>;
}
