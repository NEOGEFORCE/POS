"use client";

import { ReactNode } from "react";
import { Card, CardBody, Button } from "@heroui/react";
import { IconSearch, IconPlus } from "@tabler/icons-react";

interface EmptyStateProps {
    title: string;
    description: string;
    icon?: ReactNode;
    actionLabel?: string;
    onAction?: () => void;
    compact?: boolean;
}

export const EmptyState = ({
    title,
    description,
    icon,
    actionLabel,
    onAction,
    compact = false
}: EmptyStateProps) => {
    const defaultIcon = <IconSearch size={compact ? 24 : 48} className="text-gray-300" />;
    
    return (
        <Card className={`w-full border-2 border-dashed border-gray-200 dark:border-white/10 bg-transparent shadow-none ${compact ? 'py-4' : 'py-12'}`}>
            <CardBody className={`flex flex-col items-center justify-center text-center ${compact ? 'space-y-2' : 'space-y-4'}`}>
                <div className={`${compact ? 'p-2' : 'p-4'} bg-gray-50 rounded-full dark:bg-white/5`}>
                    {icon || defaultIcon}
                </div>
                <div className={compact ? 'space-y-0' : 'space-y-1'}>
                    <h3 className={`${compact ? 'text-sm' : 'text-lg'} font-bold text-gray-900 dark:text-white uppercase italic tracking-tight`}>{title}</h3>
                    <p className={`${compact ? 'text-[10px]' : 'text-sm'} text-gray-500 dark:text-gray-400 max-w-xs uppercase font-black italic opacity-60`}>
                        {description}
                    </p>
                </div>
                {actionLabel && onAction && (
                    <Button 
                        color="success" 
                        variant="flat"
                        size={compact ? "sm" : "md"}
                        startContent={<IconPlus size={compact ? 14 : 18} />}
                        onPress={onAction}
                        className={compact ? "h-8 px-4 text-[10px] font-black uppercase italic" : "mt-2"}
                    >
                        {actionLabel}
                    </Button>
                )}
            </CardBody>
        </Card>
    );
};
